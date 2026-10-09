#!/usr/bin/env python3
"""
readyapi_to_postman.py — deterministic ReadyAPI/SoapUI project -> Postman converter.

Pipeline:  ReadyAPI XML  ->  intermediate model (IR)  ->  Collection v2.1 JSON
                                                       ->  performance run config
                                                       ->  conversion report

Design mirrors the sibling JMeter skill: everything structural is deterministic
and stdlib-only (xml.etree, json, argparse, re, os). The only judgment calls left
to a host model are (a) translating Groovy scripts/assertions to JavaScript and
(b) extractor-style assertions (XPath/JSONPath) the sandbox cannot evaluate.
Those are emitted as explicit `manual_tasks` so a model can finish them. This
script NEVER calls an LLM or the network.

Usage:
    python3 readyapi_to_postman.py INPUT.xml -o OUTDIR [--json-report]

Outputs in OUTDIR (base name = input filename without extension):
    <name>.postman_collection.json   Collection v2.1 (import-ready)
    <name>.perf.json                 machine-readable perf config (build_perf output)
    <name>.perf.md                   human-readable perf config + CLI command(s)
    <name>.report.md                 conversion report (what/approx/manual/skipped)
    <name>.ir.json                   raw IR (collection name, vars, folders, tasks)
"""
import argparse
import json
import os
import re
import sys
import xml.etree.ElementTree as ET

# Import the two deterministic helper modules shipped alongside this script.
try:
    from groovy_to_js import translate as groovy_translate
    from loadtest_to_perf import build_perf, cli_command
except ImportError:  # allow running from any cwd
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from groovy_to_js import translate as groovy_translate
    from loadtest_to_perf import build_perf, cli_command

SCHEMA_V21 = "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"


# ===========================================================================
# XML helpers — everything matches on local-name so a missing/odd namespace
# prefix never breaks a lookup.
# ===========================================================================

def _ln(tag):
    """Local name of a (possibly namespaced) ElementTree tag."""
    return tag.split('}')[-1] if '}' in tag else tag


def find_child(el, name):
    """First direct child with the given local-name, or None."""
    if el is None:
        return None
    for c in el:
        if _ln(c.tag) == name:
            return c
    return None


def find_children(el, name):
    """All direct children with the given local-name."""
    if el is None:
        return []
    return [c for c in el if _ln(c.tag) == name]


def text_of(el, name, default=''):
    """Text of the first direct child with local-name `name`."""
    c = find_child(el, name)
    if c is None or c.text is None:
        return default
    return c.text.strip()


def _num(s):
    """Parse a string as int (preferred) or float; None if absent/non-numeric."""
    if s is None:
        return None
    s = s.strip()
    if s == '':
        return None
    try:
        return int(s)
    except ValueError:
        pass
    try:
        return float(s)
    except ValueError:
        return None


# ===========================================================================
# ReadyAPI variable syntax -> Postman {{var}}
# ===========================================================================

# ${#Project#x}, ${#TestCase#x}, ${#TestSuite#x}, ${#Global#x}, ${#MockService#x},
# ${StepName#prop}, and bare ${x}. We keep only the LAST identifier so every
# scope/step prefix collapses to a single Postman collection variable.
_SCOPED_VAR = re.compile(r'\$\{\s*#?[^}]*?#([A-Za-z0-9_\-. ]+?)\s*\}')  # has a '#' separator
_BARE_VAR = re.compile(r'\$\{\s*([A-Za-z0-9_\-. ]+?)\s*\}')             # no '#'

# ReadyAPI inline Groovy expansions ${=expr}. A few map cleanly onto Postman's
# dynamic variables; anything else must stay literal (we can't evaluate Groovy at
# convert time) and is flagged for manual review via _DYNAMIC_EXPR_WARN below.
_DYNAMIC_EXPR = [
    (re.compile(r'\$\{=\s*[^}]*currentTimeMillis[^}]*\}'), '{{$timestamp}}'),
    (re.compile(r'\$\{=\s*(?:new\s+)?(?:java\.util\.)?UUID[^}]*\}'), '{{$guid}}'),
    (re.compile(r'\$\{=\s*(?:new\s+)?(?:java\.(?:util|text)\.)?(?:Date|SimpleDateFormat)[^}]*\}'),
     '{{$isoTimestamp}}'),
]
# Any ${=...} that survives the table is left verbatim; we remember it here so
# parse_project can raise one "needs manual review" warning per distinct literal.
_DYNAMIC_EXPR_WARN = set()

# Services whose endpoint could not be resolved (it lives in a ReadyAPI environment,
# not on the step/interface). Instead of a host-less URL we use a base-URL variable
# and register it in parse_project. Mirrors the hosted engine's {{<service>-baseURL}}.
_BASEURL_VARS = set()


def _base_url_fallback(service):
    """Return a `{{<service>-baseURL}}` token and remember it, so a request whose
    endpoint is unresolved stays sendable instead of emitting a host-less URL."""
    key = (service.strip() + '-baseURL') if (service and service.strip()) else 'baseUrl'
    _BASEURL_VARS.add(key)
    return '{{' + key + '}}'


def _apply_dynamic_exprs(s):
    """Map common ReadyAPI ${=...} dynamic expressions to Postman dynamic vars.

    Known clocks/UUID/date expressions become {{$timestamp}}/{{$guid}}/
    {{$isoTimestamp}}. Unrecognised ${=expr} values are left literal (NOT turned
    into {{=...}}) and recorded for a manual-review warning."""
    for pat, repl in _DYNAMIC_EXPR:
        s = pat.sub(repl, s)
    for m in re.finditer(r'\$\{=[^}]*\}', s):
        _DYNAMIC_EXPR_WARN.add(m.group(0))
    return s


def readyapi_vars_to_postman(s):
    """Rewrite any ReadyAPI ${...} variable reference to Postman {{var}}.

    Scope (#Project/#TestCase/...) and step (StepName#prop) prefixes are stripped;
    the trailing identifier survives because all ReadyAPI property scopes are
    flattened into one Postman collection-variable namespace.
    """
    if not s:
        return s
    # Dynamic ${=expr} first, so the generic ${...} passes never see the '=' form.
    s = _apply_dynamic_exprs(s)
    # Scoped next (anything containing a '#'); the last path segment wins.
    s = _SCOPED_VAR.sub(lambda m: '{{' + m.group(1).strip().split('#')[-1].split('.')[-1] + '}}', s)
    # Then bare ${x}.
    s = _BARE_VAR.sub(lambda m: '{{' + m.group(1).strip() + '}}', s)
    return s


# ===========================================================================
# PARSE — project -> IR
# ===========================================================================

def parse_properties(el):
    """<con:properties><con:property><con:name/><con:value/> -> list of {key,value}."""
    out = []
    props = find_child(el, 'properties')
    if props is None:
        return out
    for p in find_children(props, 'property'):
        name = text_of(p, 'name')
        if not name:
            continue
        out.append({'key': name, 'value': readyapi_vars_to_postman(text_of(p, 'value'))})
    return out


def parse_interfaces(root):
    """Build a method lookup keyed by (service, methodName) and (service, resourcePath).

    Each value carries the HTTP verb, the first endpoint, and the schema-level
    query-parameter defaults declared on the method/resource. The taxforms bug
    hinges on those defaults: a test step can leave a query entry blank and still
    be expected to send the method's default value.
    """
    verbs = {}           # (service, methodName) -> verb
    endpoints = {}       # service -> endpoint
    method_params = {}   # (service, methodName) -> {paramName: default}
    method_styles = {}   # (service, methodName) -> {paramName: STYLE}
    soap_versions = {}   # service -> '1_1' | '1_2' (drives the SOAP Content-Type)
    # All interfaces (REST and WSDL) contribute their endpoint; only REST ones add
    # resource methods, which is the shape find_children naturally gives us.
    for iface in find_children(root, 'interface'):
        service = iface.get('name', '')
        soap_versions[service] = iface.get('soapVersion', '1_1')
        eps = find_child(iface, 'endpoints')
        if eps is not None:
            ep = find_child(eps, 'endpoint')
            if ep is not None and ep.text:
                endpoints[service] = ep.text.strip()
        for res in find_children(iface, 'resource'):
            for meth in find_children(res, 'method'):
                mname = meth.get('name', '')
                verb = (meth.get('method') or 'GET').upper()
                verbs[(service, mname)] = verb
                # Collect parameter schema defaults + style for this method. `style`
                # (TEMPLATE/QUERY/HEADER/MATRIX) decides where a parameter goes in the
                # request; HEADER params must become Postman headers, not query args.
                defaults = {}
                styles = {}
                for scope in (res, meth):  # method params override resource params
                    mparams = find_child(scope, 'parameters')
                    for prm in find_children(mparams, 'parameter'):
                        pn = text_of(prm, 'name')
                        if not pn:
                            continue
                        dv = text_of(prm, 'value') or text_of(prm, 'default')
                        if dv:
                            defaults[pn] = dv
                        st = (text_of(prm, 'style') or prm.get('style') or '').upper()
                        if st:
                            styles[pn] = st
                method_params[(service, mname)] = defaults
                method_styles[(service, mname)] = styles
    return {'verbs': verbs, 'endpoints': endpoints, 'method_params': method_params,
            'method_styles': method_styles, 'soap_versions': soap_versions}


def _config_of(step):
    """The <con:config> element of a test step (holds xsi:type + attrs)."""
    return find_child(step, 'config')


def _xsi_type(el):
    """Short xsi:type local name, e.g. 'RestRequestStep' (or '' if absent)."""
    if el is None:
        return ''
    raw = el.get('{http://www.w3.org/2001/XMLSchema-instance}type', '')
    return raw.split(':')[-1] if raw else ''


def parse_assertions(container, req_name, manual_tasks):
    """Convert request-level <con:assertion> children into pm.test JS lines.

    Deterministic assertion families become real pm.test blocks; script/XPath/
    JSONPath ones become manual_tasks (the sandbox can't evaluate them).
    """
    lines = []
    for a in find_children(container, 'assertion'):
        atype = (a.get('type') or '').strip()
        aname = a.get('name') or atype
        # codes/token may sit under <con:configuration> or directly on the assertion.
        cfg = find_child(a, 'configuration')
        if cfg is None:
            cfg = a

        if atype == 'Valid HTTP Status Codes':
            raw = text_of(cfg, 'codes') or a.get('codes') or ''
            codes = [c.strip() for c in raw.split(',') if c.strip()]
            if not codes:
                lines.append(f'// [skipped] "{aname}": no status codes listed')
                continue
            arr = ', '.join(str(_num(c) if _num(c) is not None else c) for c in codes)
            lines.append(f'pm.test("{_esc(aname)}", function () {{')
            lines.append(f'    pm.expect([{arr}]).to.include(pm.response.code);')
            lines.append('});')

        elif atype in ('Simple Contains', 'Contains'):
            token = text_of(cfg, 'token')
            ignore = (text_of(cfg, 'ignoreCase') or '').lower() == 'true'
            lines.extend(_contains_js(aname, token, ignore, negate=False))

        elif atype in ('Simple NotContains', 'NotContains', 'Not Contains'):
            token = text_of(cfg, 'token')
            ignore = (text_of(cfg, 'ignoreCase') or '').lower() == 'true'
            lines.extend(_contains_js(aname, token, ignore, negate=True))

        elif atype in ('Response SLA', 'Response TimeOut', 'SLA'):
            ms = _num(text_of(cfg, 'SLA') or text_of(cfg, 'maxTime') or a.get('maxValue') or a.get('SLA'))
            if ms is None:
                lines.append(f'// [skipped] "{aname}": SLA limit not readable')
                continue
            lines.append(f'pm.test("{_esc(aname)}", function () {{')
            lines.append(f'    pm.expect(pm.response.responseTime).to.be.below({ms});')
            lines.append('});')

        elif atype in ('Script Assertion', 'GroovyScriptAssertion'):
            script = text_of(cfg, 'script') or text_of(a, 'script')
            tr = groovy_translate(script, 'groovy')
            lines.append(f'// --- converted from ReadyAPI script assertion "{_esc(aname)}" (REVIEW) ---')
            lines.extend(_review_banner(tr['reasons']))
            lines.extend(_safe_body(tr['js']))
            manual_tasks.append({'request': req_name, 'kind': 'script',
                                 'detail': f'Script assertion "{aname}" auto-translated from Groovy; review: '
                                           + ('; '.join(tr['reasons']) or 'verify fidelity.')})

        elif atype in ('XPath Match', 'XQuery Match'):
            manual_tasks.append({'request': req_name, 'kind': 'xpath',
                                 'detail': f'{atype} assertion "{aname}" needs manual conversion; the Postman sandbox has no XPath/XQuery engine.'})
            lines.append(f'// [manual] {atype} assertion "{_esc(aname)}" — see conversion report')

        elif atype in ('JsonPath Match', 'JsonPath Count'):
            path = text_of(cfg, 'path')
            expected = text_of(cfg, 'content')
            access = jsonpath_to_js(path)
            if access is None:
                # Complex path (wildcards/filters/recursion) — the sandbox can't
                # mechanically evaluate it; keep it a manual task.
                manual_tasks.append({'request': req_name, 'kind': 'jsonpath',
                                     'detail': f'{atype} assertion "{aname}" needs manual conversion; '
                                               f'port the JsonPath to a pm.expect on pm.response.json().'})
                lines.append(f'// [manual] {atype} assertion "{_esc(aname)}" ({path}) — see conversion report')
            else:
                lines.append(f'pm.test("JsonPath: {_esc(path)}", function () {{')
                if atype == 'JsonPath Count':
                    lines.append(f'    pm.expect({access}).to.have.lengthOf({_num_or_js(expected)});')
                else:
                    lines.append(f'    pm.expect({access}).to.eql({_num_or_js(expected)});')
                lines.append('});')

        elif atype:
            manual_tasks.append({'request': req_name, 'kind': 'assertion', 'detail': atype})
            lines.append(f'// [manual] assertion "{_esc(aname)}" (type {atype}) — see conversion report')
    return lines


def _contains_js(name, token, ignore, negate):
    """pm.test for Simple Contains / NotContains, honouring ignoreCase."""
    if not token:
        return [f'// [skipped] "{_esc(name)}": empty token']
    method = 'to.not.include' if negate else 'to.include'
    if ignore:
        tok = _esc(token.lower())
        return [f'pm.test("{_esc(name)}", function () {{',
                f'    pm.expect(pm.response.text().toLowerCase()).{method}("{tok}");',
                '});']
    return [f'pm.test("{_esc(name)}", function () {{',
            f'    pm.expect(pm.response.text()).{method}("{_esc(token)}");',
            '});']


# JSONPath chars that mean a filter/wildcard/recursion we cannot rewrite into a
# plain JS property access; their presence sends the assertion to a manual task.
_JSONPATH_COMPLEX = set('*?@(),:')


def jsonpath_to_js(path):
    """Simple JSONPath (e.g. `$.a.b[0].c`) -> JS accessor `pm.response.json().a.b[0].c`.

    Returns None for any path with a wildcard/filter/recursive-descent operator,
    which the sandbox cannot evaluate mechanically (kept as a manual task)."""
    if not path:
        return None
    if '..' in path or any(c in path for c in _JSONPATH_COMPLEX):
        return None
    p = path.strip()
    if p.startswith('$'):
        p = p[1:]
    p = p.replace('.[', '[')          # `$.items[0]` wrote as `.[0]` -> `[0]`
    if p and not (p.startswith('.') or p.startswith('[')):
        p = '.' + p
    return 'pm.response.json()' + p


def _num_or_js(v):
    """Render an expected assertion value: numeric literal if it parses, else a
    JS-escaped double-quoted string."""
    if _num(v) is not None:
        return str(_num(v))
    return '"' + _esc(v or '') + '"'


# ===========================================================================
# Step parsers — each returns an IR item dict (or None) and appends side effects
# (warnings / manual_tasks) to the shared plan lists.
# ===========================================================================

def _step_endpoint(rest_req, ifaces, service):
    """Resolve a step's endpoint: explicit <con:endpoint> wins, else interface default,
    else a `{{<service>-baseURL}}` variable (so the URL is never host-less)."""
    ep = text_of(rest_req, 'endpoint')
    if ep:
        return ep
    ep = ifaces['endpoints'].get(service, '')
    if ep:
        return ep
    return _base_url_fallback(service)


def parse_rest_step(step, cfg, ifaces, warnings, manual_tasks):
    """type=restrequest (xsi:type RestRequestStep) -> Postman request item."""
    name = step.get('name') or cfg.get('methodName') or 'REST Request'
    service = cfg.get('service', '')
    resource_path = cfg.get('resourcePath', '')
    method_name = cfg.get('methodName', '')

    verb = ifaces['verbs'].get((service, method_name))
    if verb is None:
        verb = 'GET'
        warnings.append(f'Could not resolve HTTP verb for step "{name}" '
                        f'(service={service!r}, method={method_name!r}); defaulted to GET.')

    rest_req = find_child(cfg, 'restRequest')
    media = (rest_req.get('mediaType') if rest_req is not None else '') or ''
    endpoint = _step_endpoint(rest_req, ifaces, service)

    # Gather parameter entries; fall back to the interface method's schema default
    # when a step entry is blank (the taxforms customer bug).
    schema_defaults = ifaces['method_params'].get((service, method_name), {})
    entries = {}
    params_el = find_child(rest_req, 'parameters') if rest_req is not None else None
    for e in find_children(params_el, 'entry'):
        k = e.get('key')
        if k is None:
            continue
        v = e.get('value', '')
        if v == '' and schema_defaults.get(k):
            v = schema_defaults[k]
            warnings.append(f'Step "{name}" left query/template param "{k}" blank; '
                            f'filled from the interface method default "{v}".')
        entries[k] = readyapi_vars_to_postman(v)

    # Also pull in any schema defaults the step never mentioned at all.
    for k, dv in schema_defaults.items():
        if k not in entries:
            entries[k] = readyapi_vars_to_postman(dv)

    # Split entries into path substitutions ({key} in the resource path), HEADER
    # params (Authorization etc.), and query. HEADER style is declared on the
    # interface method's parameter definition.
    styles = ifaces.get('method_styles', {}).get((service, method_name), {})
    path_tmpl = resource_path or ''
    query = []
    header_params = []
    for k, v in entries.items():
        token = '{%s}' % k
        if styles.get(k) == 'HEADER':
            header_params.append({'key': k, 'value': v})
        elif token in path_tmpl:
            path_tmpl = path_tmpl.replace(token, v)
        else:
            query.append({'key': k, 'value': v})

    raw_url = readyapi_vars_to_postman((endpoint or '') + (path_tmpl or ''))
    url = build_url(raw_url, query)

    headers = list(header_params)
    body = None
    body_text = ''
    if rest_req is not None:
        body_text = text_of(rest_req, 'request')
    if body_text:
        is_json = 'json' in media.lower()
        body = {'mode': 'raw', 'raw': readyapi_vars_to_postman(body_text)}
        if is_json:
            body['options'] = {'raw': {'language': 'json'}}

    auth = parse_credentials(rest_req)

    item = {'name': name, 'request': {'method': verb, 'header': headers, 'url': url}}
    if auth is not None:
        item['request']['auth'] = auth
    if body is not None:
        item['request']['body'] = body

    test_lines = parse_assertions(rest_req, name, manual_tasks) if rest_req is not None else []
    if test_lines:
        item['event'] = [{'listen': 'test', 'script': {'type': 'text/javascript', 'exec': test_lines}}]
    return item


def parse_soap_step(step, cfg, ifaces, warnings, manual_tasks, wss):
    """type=request or xsi:type WsdlRequestStep (SOAP) -> POST request.

    Content-Type is SOAP-version aware: application/soap+xml for a 1.2 interface,
    text/xml for 1.1 (both charset=utf-8). If the project declares a WS-Security
    UsernameToken, {{WSSE_HEADER}} is injected into the envelope's <Header>."""
    name = step.get('name') or 'SOAP Request'
    req_el = find_child(cfg, 'request')
    if req_el is None:
        req_el = find_child(cfg, 'wsdlRequest')
    if req_el is None:
        req_el = cfg
    # The interface/service name drives the SOAP version lookup.
    service = (text_of(cfg, 'interface') or cfg.get('service', '')) if cfg is not None else ''
    soap_version = ifaces['soap_versions'].get(service, '1_1')
    content_type = ('application/soap+xml; charset=utf-8' if soap_version == '1_2'
                    else 'text/xml; charset=utf-8')

    endpoint = (text_of(req_el, 'endpoint') or ifaces['endpoints'].get(service, '')
                or _base_url_fallback(service))
    body_text = text_of(req_el, 'request')
    if wss is not None and not wss.get('manual') and body_text:
        body_text, injected = inject_wsse(body_text)
        if not injected:
            manual_tasks.append({'request': name, 'kind': 'wss',
                                 'detail': 'Could not find a SOAP <Header> to inject {{WSSE_HEADER}}; '
                                           'add the WSSE header reference manually.'})

    headers = [{'key': 'Content-Type', 'value': content_type}]
    action = text_of(req_el, 'action') or (req_el.get('action') if req_el is not None else '')
    if action:
        headers.append({'key': 'SOAPAction', 'value': action})

    url = build_url(readyapi_vars_to_postman(endpoint), [])
    item = {'name': name,
            'request': {'method': 'POST', 'header': headers, 'url': url,
                        'body': {'mode': 'raw', 'raw': readyapi_vars_to_postman(body_text),
                                 'options': {'raw': {'language': 'xml'}}}}}
    auth = parse_credentials(req_el)
    if auth is not None:
        item['request']['auth'] = auth
    test_lines = parse_assertions(req_el, name, manual_tasks)
    if test_lines:
        item['event'] = [{'listen': 'test', 'script': {'type': 'text/javascript', 'exec': test_lines}}]
    return item


def parse_http_step(step, cfg, warnings):
    """type=httprequest (con:HttpRequest) -> a request.

    Unlike a REST step, an HTTP Request step carries the FULL URL in the
    `<con:endpoint>` CHILD element (e.g. `${#Project#Endpoint}/health`), its verb in
    the config `method` attribute, and its body as the TEXT (CDATA) of `<con:request>`.
    Reading endpoint as a config attribute (the old bug) left the URL empty."""
    name = step.get('name') or 'HTTP Request'
    req_el = find_child(cfg, 'request')
    verb = (cfg.get('method') or text_of(cfg, 'method') or 'GET').upper()
    endpoint = text_of(cfg, 'endpoint') or cfg.get('endpoint') or ''
    if not endpoint:
        warnings.append(f'HTTP Request step "{name}" has no endpoint; emitted with an empty URL.')
    body_text = (req_el.text or '').strip() if (req_el is not None and req_el.text) else ''
    item = {'name': name,
            'request': {'method': verb, 'header': [],
                        'url': build_url(readyapi_vars_to_postman(endpoint), [])}}
    if body_text:
        body = {'mode': 'raw', 'raw': readyapi_vars_to_postman(body_text)}
        media = (cfg.get('mediaType') or '').lower()
        if 'xml' in media or body_text.lstrip().startswith('<'):
            body['options'] = {'raw': {'language': 'xml'}}
        elif 'json' in media:
            body['options'] = {'raw': {'language': 'json'}}
        item['request']['body'] = body
    return item


def parse_groovy_step(step, cfg, manual_tasks):
    """type=groovy -> a labelled no-op request whose pre-request carries the translated JS.

    A Groovy *step* makes no HTTP call. Matching the reference ReadyAPI engine, it becomes
    a request pointed at Postman Echo (always 200 OK), named `[Groovy] <name>`, with the
    translated script in the pre-request tab. The echo URL keeps the item SENDABLE — a
    collection run never breaks on an empty URL (the defect an empty stub caused)."""
    name = step.get('name') or 'Groovy Script'
    script = text_of(cfg, 'script')
    tr = groovy_translate(script, 'groovy')
    pre = [f'// --- ReadyAPI Groovy script step "{_esc(name)}" — no HTTP call (REVIEW) ---']
    pre.extend(_review_banner(tr['reasons']))
    pre.extend(_safe_body(tr['js']))
    manual_tasks.append({'request': name, 'kind': 'script',
                         'detail': 'Groovy script step auto-translated; review: '
                                   + ('; '.join(tr['reasons']) or 'verify fidelity.')})
    return {'name': f'[Groovy] {name}',
            'event': [{'listen': 'prerequest', 'script': {'type': 'text/javascript', 'exec': pre}}],
            'request': {'method': 'GET', 'header': [],
                        'url': build_url('https://postman-echo.com/get',
                                         [{'key': 'groovyStep', 'value': 'true'}]),
                        'description': (f'Groovy script step "{name}" — no HTTP call. The translated '
                                        'script runs in the pre-request tab; Postman Echo is a no-op '
                                        '(always 200 OK). Review the pre-request script.')}}


def parse_jdbc_step(step, cfg, manual_tasks):
    """type containing 'jdbc' -> a labelled placeholder request carrying the SQL, flagged manual.

    Postman has no DB connectivity, so (matching the reference engine) this becomes a POST
    to a sentinel URL named `<name> [JDBC - To Do]`, SQL preserved in the body, to be
    repointed at a read-only query API. Sentinel URL keeps the item sendable (never empty)."""
    name = step.get('name') or 'JDBC Request'
    sql = (text_of(cfg, 'query') or text_of(cfg, 'sql') or '')
    manual_tasks.append({'request': name, 'kind': 'jdbc',
                         'detail': 'Postman has no DB connectivity; expose via a read-only query API'})
    body_obj = {'_note': 'Placeholder for a JDBC request. Postman cannot execute SQL directly.',
                'query': sql}
    return {'name': f'{name} [JDBC - To Do]',
            'request': {'method': 'POST',
                        'header': [{'key': 'Content-Type', 'value': 'application/json'},
                                   {'key': 'X-ReadyAPI-Note',
                                    'value': 'Placeholder JDBC request — implement a real DB query API'}],
                        'url': build_url('https://internal.api/sql', []),
                        'body': {'mode': 'raw', 'raw': json.dumps(body_obj, indent=2),
                                 'options': {'raw': {'language': 'json'}}},
                        'description': (f'JDBC step "{name}". Postman cannot execute SQL; repoint this '
                                        'at a read-only query API. The SQL is preserved in the body.')}}


def parse_credentials(container):
    """<con:credentials> -> Postman auth dict, or None to inherit from parent.

    Basic -> basic; No Authorization -> noauth; Inherit/missing -> None (omit).
    """
    if container is None:
        return None
    creds = find_child(container, 'credentials')
    if creds is None:
        return None
    auth_type = text_of(creds, 'authType')
    selected = text_of(creds, 'selectedAuthProfile')
    if auth_type == 'Basic' or (selected == 'Basic'):
        return {'type': 'basic',
                'basic': [{'key': 'username', 'value': readyapi_vars_to_postman(text_of(creds, 'username')), 'type': 'string'},
                          {'key': 'password', 'value': readyapi_vars_to_postman(text_of(creds, 'password')), 'type': 'string'}]}
    if auth_type == 'No Authorization' and selected in ('', 'No Authorization'):
        return {'type': 'noauth'}
    # "Inherit From Parent" (or anything else) -> omit so the folder/collection auth applies.
    return None


# ---------------------------------------------------------------------------
# WS-Security UsernameToken (<con:outgoingWss>)
# ---------------------------------------------------------------------------

def parse_wss(root):
    """Parse the project's outgoing WS-Security UsernameToken, or None.

    Standard UsernameToken (PasswordText/PasswordDigest) returns a dict the WSSE
    pre-request template understands. Anything else (Signature/Encryption/custom)
    returns a dict with a 'manual' message so the caller files a manual task."""
    container = find_child(root, 'wssContainer')
    if container is None:
        return None
    outgoing = find_child(container, 'outgoingWss')
    if outgoing is None:
        return None
    for entry in find_children(outgoing, 'entry'):
        etype = _xsi_type(entry)
        if etype and etype not in ('UsernameToken',):
            return {'manual': f'WS-Security "{etype}" (Signature/Encryption/custom) cannot be scripted '
                              f'deterministically; configure it manually.'}
        if etype == 'UsernameToken' or entry.get('username'):
            ptype = entry.get('passwordType', 'PasswordText')
            return {
                'username': entry.get('username', ''),
                'password': entry.get('password', ''),
                'passwordType': ptype,
                'addNonce': entry.get('addNonce', 'true') == 'true',
                'addCreated': entry.get('addCreated', 'true') == 'true',
            }
    return None


def inject_wsse(body):
    """Inject a {{WSSE_HEADER}} reference into a SOAP envelope's <Header>.

    Handles a self-closing <Header/>, an existing <Header>...</Header>, or (last
    resort) adds a <Header> right after <Envelope ...>. Returns (new_body, injected)."""
    if '{{WSSE_HEADER}}' in body:
        return body, True
    m = re.search(r'<(\w+:)?Header\s*/>', body)
    if m:
        pre = m.group(1) or ''
        return body[:m.start()] + '<' + pre + 'Header>{{WSSE_HEADER}}</' + pre + 'Header>' + body[m.end():], True
    m = re.search(r'<(\w+:)?Header\b[^>]*>', body)
    if m:
        return body[:m.end()] + '{{WSSE_HEADER}}' + body[m.end():], True
    m = re.search(r'<(\w+:)?Envelope\b[^>]*>', body)
    if m:
        pre = m.group(1) or ''
        return body[:m.end()] + '<' + pre + 'Header>{{WSSE_HEADER}}</' + pre + 'Header>' + body[m.end():], True
    return body, False


def wsse_prerequest(wss):
    """Collection-level pre-request lines that build {{WSSE_HEADER}} via CryptoJS.

    Hand-written and balanced by construction. PasswordText sends the password
    verbatim; PasswordDigest sends Base64(SHA1(nonce + created + password))."""
    digest = wss['passwordType'] != 'PasswordText'
    pw_uri = ('http://docs.oasis-open.org/wss/2004/01/'
              'oasis-200401-wss-username-token-profile-1.0#' +
              ('PasswordDigest' if digest else 'PasswordText'))
    lines = [
        '// WS-Security UsernameToken (from <con:outgoingWss>); inherited by every request.',
        "const CryptoJS = require('crypto-js');",
        "const username = pm.collectionVariables.get('wsse_username') || '';",
        "const password = pm.collectionVariables.get('wsse_password') || '';",
        'const created = new Date().toISOString();',
        'const nonceBytes = CryptoJS.lib.WordArray.random(16);',
        'const nonceBase64 = CryptoJS.enc.Base64.stringify(nonceBytes);',
    ]
    if digest:
        # WSSE PasswordDigest = Base64(SHA1(nonceBytes + utf8(created) + utf8(password))).
        lines.append('const digestInput = nonceBytes.clone()'
                     '.concat(CryptoJS.enc.Utf8.parse(created))'
                     '.concat(CryptoJS.enc.Utf8.parse(password));')
        lines.append('const passwordValue = CryptoJS.enc.Base64.stringify(CryptoJS.SHA1(digestInput));')
    else:
        lines.append('const passwordValue = password;')
    # Build the header as string concatenation; every literal is single-quoted and
    # balanced, so the emitted JS always parses.
    lines.append("let header = '<wsse:Security "
                 "xmlns:wsse=\"http://docs.oasis-open.org/wss/2004/01/"
                 "oasis-200401-wss-wssecurity-secext-1.0.xsd\" "
                 "xmlns:wsu=\"http://docs.oasis-open.org/wss/2004/01/"
                 "oasis-200401-wss-wssecurity-utility-1.0.xsd\">';")
    lines.append("header += '<wsse:UsernameToken>';")
    lines.append("header += '<wsse:Username>' + username + '</wsse:Username>';")
    lines.append("header += '<wsse:Password Type=\"" + pw_uri + "\">' + passwordValue + '</wsse:Password>';")
    if wss['addNonce']:
        lines.append("header += '<wsse:Nonce EncodingType=\"http://docs.oasis-open.org/wss/2004/01/"
                     "oasis-200401-wss-soap-message-security-1.0#Base64Binary\">' + nonceBase64 + '</wsse:Nonce>';")
    if wss['addCreated']:
        lines.append("header += '<wsu:Created>' + created + '</wsu:Created>';")
    lines.append("header += '</wsse:UsernameToken></wsse:Security>';")
    lines.append("pm.collectionVariables.set('WSSE_HEADER', header);")
    return lines


# ---------------------------------------------------------------------------
# Property Transfer & DataSource
# ---------------------------------------------------------------------------

def parse_transfers(step, cfg):
    """A PropertyTransfer step -> list of {name, source_step, source_path, target_prop, lang}."""
    out = []
    if cfg is None:
        return out
    for t in find_children(cfg, 'transfers'):
        out.append({
            'name': text_of(t, 'name') or 'transfer',
            'source_step': text_of(t, 'sourceStep'),
            'source_path': text_of(t, 'sourcePath'),
            'target_prop': text_of(t, 'targetType') or text_of(t, 'name') or 'value',
            'lang': (text_of(t, 'type') or 'XPATH').upper(),
        })
    return out


def _find_item_by_name(items, name):
    """First request item in `items` whose name matches `name` (or None)."""
    for it in items:
        if it.get('name') == name and 'request' in it:
            return it
    return None


def _append_test_line(item, line):
    """Append a JS line to an item's test event, creating the event if needed."""
    for ev in item.setdefault('event', []):
        if ev.get('listen') == 'test':
            ev['script']['exec'].append(line)
            return
    item['event'].append({'listen': 'test',
                          'script': {'type': 'text/javascript', 'exec': [line]}})


def fold_transfer(t, case_items, warnings, manual_tasks):
    """Fold a property transfer into its source request's test event.

    JSONPath/simple sources become a `pm.collectionVariables.set(...)` line on the
    source request. XPath sources stay a manual task (an xml2js scaffold comment)."""
    src = _find_item_by_name(case_items, t['source_step'])
    if src is None:
        warnings.append(f'Property Transfer "{t["name"]}" source step "{t["source_step"]}" '
                        f'is not an HTTP request in this case; left as a manual task.')
        manual_tasks.append({'request': t['source_step'] or '(unknown)', 'kind': 'property_transfer',
                             'detail': f'Transfer "{t["name"]}" has no matching source request; '
                                       f'wire the {t["target_prop"]} copy manually.'})
        return
    target = t['target_prop']
    if t['lang'] == 'JSONPATH':
        access = jsonpath_to_js(t['source_path'])
        if access is None:
            manual_tasks.append({'request': src['name'], 'kind': 'property_transfer',
                                 'detail': f'Transfer "{t["name"]}" uses a complex JSONPath '
                                           f'"{t["source_path"]}"; finish the extraction by hand.'})
            _append_test_line(src, f'// [manual] Property Transfer "{_esc(t["name"])}": '
                                   f'complex JSONPath {t["source_path"]} — see report')
            return
        _append_test_line(src, f'pm.collectionVariables.set("{_esc(target)}", {access});')
    else:
        # XPath/XQuery: emit a balanced xml2js scaffold the model completes. Each
        # block is wrapped in its own IIFE so repeated transfers on one request do
        # not redeclare `xml2js` (which would be invalid JS).
        manual_tasks.append({'request': src['name'], 'kind': 'property_transfer',
                             'detail': f'Transfer "{t["name"]}" uses XPath "{t["source_path"]}"; '
                                       f'finish the xml2js extraction.'})
        for ln in [
            f'// [manual] Property Transfer "{_esc(t["name"])}" (XPath {_esc(t["source_path"])}):',
            '(function () {',
            "    const xml2js = require('xml2js');",
            "    xml2js.parseString(pm.response.text(), { explicitArray: false, ignoreAttrs: true }, function (err, parsed) {",
            f'        // extract the value for XPath {_esc(t["source_path"])} from `parsed`, then:',
            f'        pm.collectionVariables.set("{_esc(target)}", "");',
            '    });',
            '})();',
        ]:
            _append_test_line(src, ln)


def parse_datasource(step, cfg):
    """A DataSource/DataSink step -> {filename, columns} for the perf dataset config."""
    ds = find_child(cfg, 'dataSource')
    if ds is None:
        return None
    props = find_child(ds, 'properties')
    columns = [text_of(p, 'name') for p in find_children(props, 'property')]
    columns = [c for c in columns if c]
    filename = ''
    for provider in ('fileDataSource', 'excelDataSource', 'directoryDataSource', 'gridDataSource'):
        pv = find_child(ds, provider)
        if pv is not None:
            filename = text_of(pv, 'file') or text_of(pv, 'directory') or ''
            break
    if filename:
        # Strip the ${projectDir} prefix and keep just the basename.
        filename = filename.replace('${projectDir}', '').strip('/\\')
        filename = os.path.basename(filename)
    return {'filename': filename or 'dataset.csv', 'columns': columns,
            'step': step.get('name', '')}


def parse_test_step(step, ifaces, variables, warnings, manual_tasks, datasets, transfers, wss):
    """Dispatch one <con:testStep> to the right parser. Returns an IR item or None.

    `datasets`/`transfers` are shared accumulators appended in place; `wss` is the
    parsed WS-Security config (or None) used to inject {{WSSE_HEADER}} into SOAP."""
    stype = (step.get('type') or '').lower()
    cfg = _config_of(step)
    xsi = _xsi_type(cfg)
    name = step.get('name') or stype or 'step'

    if stype == 'restrequest' or xsi == 'RestRequestStep':
        return parse_rest_step(step, cfg, ifaces, warnings, manual_tasks)

    if stype == 'request' or xsi == 'WsdlRequestStep':
        return parse_soap_step(step, cfg, ifaces, warnings, manual_tasks, wss)

    if stype == 'httprequest' or xsi == 'HttpRequestStep':
        return parse_http_step(step, cfg, warnings)

    if stype == 'properties' or xsi == 'PropertiesStep':
        # Fold a Properties step's entries straight into collection variables.
        added = 0
        for e in find_children(cfg, 'property') + find_children(cfg, 'entry'):
            k = text_of(e, 'name') or e.get('key')
            v = text_of(e, 'value') or e.get('value', '')
            if k:
                variables.append({'key': k, 'value': readyapi_vars_to_postman(v)})
                added += 1
        warnings.append(f'Properties step "{name}" folded {added} entr{"y" if added == 1 else "ies"} '
                        f'into collection variables (ReadyAPI property scopes were flattened).')
        return None

    if stype == 'transfer' or xsi == 'PropertyTransferStep':
        for t in parse_transfers(step, cfg):
            transfers.append(t)
        return None

    if stype == 'groovy' or xsi == 'GroovyScriptStep':
        return parse_groovy_step(step, cfg, manual_tasks)

    if 'jdbc' in stype or 'jdbc' in xsi.lower():
        return parse_jdbc_step(step, cfg, manual_tasks)

    # DataSourceLoop is dropped (perf runs iterate the dataset automatically); a
    # real DataSource is captured as a perf dataset AND left as a manual export task.
    if stype == 'datasourceloop' or xsi == 'DataSourceLoopStep':
        warnings.append(f'DataSource Loop "{name}" dropped (Postman perf runs iterate the dataset automatically).')
        return None

    if stype in ('datasource', 'datasink') or xsi in ('DataSourceStep', 'DataSinkStep'):
        ds = parse_datasource(step, cfg)
        if ds is not None:
            datasets.append(ds)
            cols = ', '.join(ds['columns']) or '(none detected)'
            warnings.append(f'DataSource "{name}" -> perf dataset "{ds["filename"]}" '
                            f'(columns {cols} read via pm.iterationData.get(...)).')
        manual_tasks.append({'request': name, 'kind': 'datasource',
                             'detail': 'ReadyAPI DataSource/DataSink; export the rows to CSV/JSON and pass '
                                       'the file to the run via --data-file/--dataset.'})
        return None

    if stype == 'delay' or xsi == 'DelayStep':
        warnings.append(f'Delay step "{name}" dropped (Postman performance runs have no think-time step).')
        return None

    warnings.append(f'step type "{stype or xsi or "unknown"}" skipped (step "{name}").')
    return None


def parse_load_test(lt, test_case_name):
    """One <con:loadTest> -> the intermediate dict consumed by loadtest_to_perf.build_perf."""
    strat = find_child(lt, 'loadStrategy')
    stype = text_of(strat, 'type') or 'Simple'
    scfg_el = find_child(strat, 'config')
    cfg = {}
    for key in ('testDelay', 'randomFactor', 'startThreadCount', 'endThreadCount',
                'burstDuration', 'burstDelay', 'interval', 'variance', 'rate', 'maxThreads'):
        cfg[key] = _num(text_of(scfg_el, key))

    assertions = []
    for a in find_children(lt, 'assertion'):
        assertions.append({
            'type': a.get('type'),
            'name': a.get('name'),
            'maxValue': _num(a.get('maxValue')),
            'minValue': _num(a.get('minValue')),
            'value': _num(a.get('value')),
            'limit': _num(a.get('limit')),
            'maxAbsolute': _num(a.get('maxAbsolute')),
            'maxRelative': _num(a.get('maxRelative')),
        })

    disabled = (lt.get('disabled') or text_of(lt, 'disabled') or '').lower() == 'true'
    return {
        'name': lt.get('name') or 'LoadTest',
        'testCaseName': test_case_name,
        'disabled': disabled,
        'threadCount': _num(text_of(lt, 'threadCount')),
        'startDelay': _num(text_of(lt, 'startDelay')),
        'limitType': (text_of(lt, 'limitType') or 'TIME').upper(),
        'testLimit': _num(text_of(lt, 'testLimit')),
        'maxAssertionErrors': _num(text_of(lt, 'maxAssertionErrors')),
        'strategy': {'type': stype, 'config': cfg},
        'assertions': assertions,
    }


def _folder_scripts(container, folder_name, manual_tasks):
    """setupScript/tearDownScript on a suite or case -> folder prerequest/test events."""
    events = []
    setup = text_of(container, 'setupScript')
    if setup:
        tr = groovy_translate(setup, 'groovy')
        exec_lines = [f'// --- converted from ReadyAPI setup script on "{_esc(folder_name)}" (REVIEW) ---']
        exec_lines.extend(_review_banner(tr['reasons']))
        exec_lines.extend(_safe_body(tr['js']))
        events.append({'listen': 'prerequest', 'script': {'type': 'text/javascript', 'exec': exec_lines}})
        manual_tasks.append({'request': folder_name, 'kind': 'script',
                             'detail': 'Setup script auto-translated from Groovy; review for fidelity.'})
    teardown = text_of(container, 'tearDownScript')
    if teardown:
        tr = groovy_translate(teardown, 'groovy')
        exec_lines = [f'// --- converted from ReadyAPI teardown script on "{_esc(folder_name)}" (REVIEW) ---']
        exec_lines.extend(_review_banner(tr['reasons']))
        exec_lines.extend(_safe_body(tr['js']))
        events.append({'listen': 'test', 'script': {'type': 'text/javascript', 'exec': exec_lines}})
        manual_tasks.append({'request': folder_name, 'kind': 'script',
                             'detail': 'Teardown script auto-translated from Groovy; review for fidelity.'})
    return events


def parse_project(path):
    """Parse the ReadyAPI XML into the IR used by every downstream builder."""
    tree = ET.parse(path)
    root = tree.getroot()
    if _ln(root.tag) != 'soapui-project':
        raise ValueError('root element is not <con:soapui-project>')

    _DYNAMIC_EXPR_WARN.clear()  # fresh per conversion (module-level accumulators)
    _BASEURL_VARS.clear()
    name = root.get('name') or 'ReadyAPI Project'
    variables = []
    warnings = []
    manual_tasks = []
    load_tests = []
    datasets = []

    ifaces = parse_interfaces(root)
    wss = parse_wss(root)
    if wss is not None and wss.get('manual'):
        manual_tasks.append({'request': '(collection)', 'kind': 'wss',
                             'detail': wss['manual']})

    # Project-level properties -> collection variables (scope flattening warned once).
    scope_flattened = False
    proj_props = parse_properties(root)
    if proj_props:
        variables.extend(proj_props)

    folders = []  # top-level suite folders
    for suite in find_children(root, 'testSuite'):
        suite_name = suite.get('name') or 'TestSuite'
        suite_props = parse_properties(suite)
        if suite_props:
            variables.extend(suite_props)
            scope_flattened = True
        suite_folder = {'name': suite_name, 'item': []}
        suite_events = _folder_scripts(suite, suite_name, manual_tasks)
        if suite_events:
            suite_folder['event'] = suite_events

        for case in find_children(suite, 'testCase'):
            case_name = case.get('name') or 'TestCase'
            case_props = parse_properties(case)
            if case_props:
                variables.extend(case_props)
                scope_flattened = True
            case_folder = {'name': case_name, 'item': []}
            case_events = _folder_scripts(case, case_name, manual_tasks)
            if case_events:
                case_folder['event'] = case_events

            case_transfers = []
            for step in find_children(case, 'testStep'):
                item = parse_test_step(step, ifaces, variables, warnings, manual_tasks,
                                       datasets, case_transfers, wss)
                if item is not None:
                    case_folder['item'].append(item)

            # Property-transfer folding: now that every request in the case is built,
            # attach each simple source->target copy to its source request's test event.
            for t in case_transfers:
                fold_transfer(t, case_folder['item'], warnings, manual_tasks)

            for lt in find_children(case, 'loadTest'):
                load_tests.append(parse_load_test(lt, case_name))

            suite_folder['item'].append(case_folder)
        folders.append(suite_folder)

    if scope_flattened or proj_props:
        warnings.append('ReadyAPI property scopes (Project/TestSuite/TestCase) were flattened '
                        'into a single Postman collection-variable namespace; last writer wins on name clashes.')

    for expr in sorted(_DYNAMIC_EXPR_WARN):
        warnings.append('dynamic expression needs manual review: %s '
                        '(left literal; Postman cannot evaluate Groovy expressions).' % expr)

    # Safety net: no request may ship with an empty/host-less URL. Any that slipped
    # through (an endpoint form not covered above) is pointed at a {{baseUrl}} var so
    # it stays sendable and editable rather than blank.
    _ensure_no_blank_urls(folders)

    # Register the base-URL variables used as endpoint fallbacks (value left blank
    # for the user to fill) and warn once.
    if _BASEURL_VARS:
        for key in sorted(_BASEURL_VARS):
            variables.append({'key': key, 'value': ''})
        warnings.append('Some requests had no endpoint in the project (it likely lives in a '
                        'ReadyAPI environment); they use these base-URL variables — set their '
                        'values in the collection: ' + ', '.join('{{%s}}' % k for k in sorted(_BASEURL_VARS)) + '.')

    collection_events = []
    if wss is not None and not wss.get('manual'):
        collection_events.append({'listen': 'prerequest',
                                  'script': {'type': 'text/javascript',
                                             'exec': wsse_prerequest(wss)}})
        # Surface the WSSE credentials as collection variables for the template.
        variables.append({'key': 'wsse_username', 'value': wss['username']})
        variables.append({'key': 'wsse_password', 'value': wss['password']})

    return {
        'name': name,
        'variables': _dedupe_vars(variables),
        'folders': folders,
        'warnings': warnings,
        'manual_tasks': manual_tasks,
        'load_tests': load_tests,
        'datasets': datasets,
        'events': collection_events,
    }


def _ensure_no_blank_urls(items):
    """Walk the folder tree; repoint any request with a blank or host-less URL at a
    {{baseUrl}} variable so it is always sendable. Last-resort guard — the REST/SOAP
    parsers already fall back to {{<service>-baseURL}}; this catches anything else."""
    for it in items or []:
        if 'item' in it:
            _ensure_no_blank_urls(it['item'])
            continue
        req = it.get('request')
        if not isinstance(req, dict):
            continue
        u = req.get('url', '')
        raw = (u.get('raw', '') if isinstance(u, dict) else u) or ''
        raw = raw.strip()
        if raw == '' or raw.startswith('/'):
            _BASEURL_VARS.add('baseUrl')
            req['url'] = build_url('{{baseUrl}}' + raw, [])


def _dedupe_vars(variables):
    """Keep the last value for each variable key (ReadyAPI scope flattening semantics)."""
    seen = {}
    for v in variables:
        seen[v['key']] = v['value']
    return [{'key': k, 'value': val} for k, val in seen.items()]


# ===========================================================================
# BUILD — IR -> Collection v2.1
# ===========================================================================

def _esc(s):
    """Escape a string for embedding inside a JS double-quoted literal."""
    return (s or '').replace('\\', '\\\\').replace('"', '\\"').replace('\n', '\\n').replace('\r', '')


def _wrap_iife(lines):
    """Wrap a translated script body in an IIFE so a top-level Groovy-style
    `return` stays legal JS and local declarations do not leak into the sandbox."""
    body = [('    ' + ln) if ln else ln for ln in lines]
    return ['(function () {'] + body + ['})();']


def _review_banner(reasons):
    """A `// REVIEW` banner, one line per reason, prefixed before a translated body."""
    if not reasons:
        return ['// REVIEW: auto-translated Groovy — verify fidelity before running.']
    return ['// REVIEW: ' + r for r in reasons]


# A parenthesis-less call is the one common Groovy shape the regex translator cannot
# rewrite into valid JS (e.g. `log.info "x"`, `assert cond`). Left raw it would break
# JS parsing for the WHOLE script, so we comment those lines out (keeping them visible
# for the host model to repair) rather than emit a collection that fails to import.
# JS statement keywords that legitimately take a bareword/literal next and must NOT be
# mistaken for a parenthesis-less call.
_JS_STMT_KW = {'let', 'var', 'const', 'return', 'throw', 'typeof', 'delete', 'void',
               'new', 'await', 'yield', 'in', 'of', 'instanceof', 'case', 'else', 'do'}
# leading-token ( member access )  whitespace  then a string/number/identifier with no operator/paren between.
_BARE_CALL = re.compile(r'^\s*([A-Za-z_$][\w$]*)((?:\.[A-Za-z_$][\w$]*)*)\s+["\']')
_GROOVY_KW = re.compile(r'^\s*(assert|import|package)\b')


def _js_safe_lines(lines):
    """Comment out translated lines that are clearly still Groovy (would not parse as JS).

    Deterministic and conservative: only neutralizes parenthesis-less calls whose
    argument starts with a string literal (the shape the regex translator leaves
    behind, e.g. `log.info "x"`) and a few Groovy-only keywords. Everything else is
    left intact for the model to review.
    """
    out = []
    for ln in lines:
        stripped = ln.strip()
        if not stripped or stripped.startswith('//'):
            out.append(ln)
            continue
        looks_groovy = bool(_GROOVY_KW.match(ln))
        m = _BARE_CALL.match(ln)
        if m and m.group(1) not in _JS_STMT_KW and '(' not in ln.split('"')[0].split("'")[0]:
            looks_groovy = True
        if looks_groovy:
            out.append('// [needs-manual-translation] ' + stripped)
        else:
            out.append(ln)
    return out


# Groovy the line-level pass cannot neutralize without breaking JS. If any of
# these survive translation the body is NOT confidently valid JS, so it is
# commented out whole rather than emitted half-translated. Covers: closures
# (`{ x -> }`), closure-taking collection ops, Java types, ranges (`0..9`),
# regex/leftShift/cast operators, triple-quoted strings, and any un-ported
# SoapUI API object (which has no pm.* target and leaves method chains raw).
_STRUCTURAL = re.compile(
    r'->'
    r'|\.each\b|\.collect\b|\.find\b|\.findAll\b|\.inject\b|\.times\b'
    r'|\bnew\s+[A-Z]|\bclass\s+\w|\bimport\s+\w'
    r'|(?<!\.)\.\.(?!\.)'          # Groovy range 0..9 (not JS spread ...)
    r'|=~|==~|<<|\bas\s+[A-Z]'     # regex-match, leftShift, cast
    r"|'''|\"\"\""                 # triple-quoted strings
    r'|\btestRunner\b|\bcontext\b|\bmessageExchange\b|\bgroovyUtils\b'  # SoapUI API
    r'|\.toCharArray\b|\bit\b\s*[.\[]'
)


def _delims_balanced(lines):
    """Rough JS delimiter balance, ignoring // comments and quoted strings. A
    half-translated closure leaves an unmatched `{`, which this catches."""
    depth = 0
    for ln in lines:
        s = ln.strip()
        if s.startswith('//'):
            continue
        s = re.sub(r'//.*$', '', ln)
        s = re.sub(r'"(?:\\.|[^"\\])*"', '', s)
        s = re.sub(r"'(?:\\.|[^'\\])*'", '', s)
        for ch in s:
            if ch in '{[(':
                depth += 1
            elif ch in '}])':
                depth -= 1
                if depth < 0:
                    return False
    return depth == 0


def _safe_body(js_text):
    """Return IIFE-wrapped exec lines that are GUARANTEED to parse as JS.

    Two tiers: if the line-level safe pass yields confidently-valid JS (no
    residual structural Groovy and balanced delimiters), emit it. Otherwise the
    translation is not trustworthy as code — comment out the WHOLE original body
    (a valid no-op) with a banner, so the collection still imports and the host
    model has the original Groovy in front of it to rewrite. This is the single
    rule that keeps bad-JS at zero on Groovy-heavy projects (closures, etc.)."""
    raw = js_text.splitlines()
    safe = _js_safe_lines(raw)
    confident = _delims_balanced(safe) and not any(_STRUCTURAL.search(ln) for ln in safe
                                                    if not ln.strip().startswith('//'))
    if confident:
        return _wrap_iife(safe)
    body = ['// [needs-manual-translation] Groovy below could not be mechanically'
            ' converted to valid JS (closures / Java types / complex flow).',
            '// Rewrite it here, then delete these comment markers:']
    body.extend('// ' + ln for ln in raw)
    return _wrap_iife(body)


def build_url(raw, query):
    """Build a Postman url object (raw + structured host/path/query) from a raw URL.

    A deliberately simple parser: scheme://host[:port]/path. Variable tokens
    ({{x}}) survive intact because we never decode them.
    """
    raw = raw or ''
    url = {'raw': raw}
    rest = raw
    protocol = ''
    m = re.match(r'^([a-zA-Z][a-zA-Z0-9+.\-]*)://(.*)$', rest)
    if m:
        protocol = m.group(1)
        rest = m.group(2)
        url['protocol'] = protocol
    # Split authority from path at the first '/'.
    host_part, _, path_part = rest.partition('/')
    port = None
    if ':' in host_part and not host_part.startswith('{{'):
        host_only, _, maybe_port = host_part.rpartition(':')
        if maybe_port.isdigit():
            host_part, port = host_only, maybe_port
    if host_part:
        url['host'] = host_part.split('.') if '.' in host_part else [host_part]
    if port:
        url['port'] = port
    seg = [p for p in path_part.split('/') if p != '']
    if seg:
        url['path'] = seg
    if query:
        url['query'] = [{'key': q['key'], 'value': q['value']} for q in query]
        url['raw'] = raw + ('?' if '?' not in raw else '&') + '&'.join(f'{q["key"]}={q["value"]}' for q in query)
    return url


def build_collection(plan):
    """Assemble the Collection v2.1 dict from the parsed IR folders."""
    coll = {
        'info': {'name': plan['name'], 'schema': SCHEMA_V21},
        'variable': [{'key': v['key'], 'value': v['value']} for v in plan['variables']],
        'item': plan['folders'],
    }
    if plan.get('events'):
        coll['event'] = plan['events']
    return coll


# ===========================================================================
# PERF — delegate entirely to loadtest_to_perf
# ===========================================================================

def render_perf_md(cfg, collection_filename):
    """Human-readable perf summary + one `postman performance run` per run."""
    lines = ['# Performance Test Configuration', '']
    if not cfg['runs']:
        lines.append('No ReadyAPI LoadTests were found in this project.')
        lines.append('')
        # Data files (from DataSources) still matter even without a LoadTest, so
        # fall through to render them rather than returning early.
        if not cfg.get('data_files'):
            return '\n'.join(lines)
    pass_if = cfg.get('pass_if') or cfg.get('pass_if_suggested')
    for i, run in enumerate(cfg['runs'], 1):
        lines.append(f'## Run {i}: {run["name"]}')
        lines.append('')
        lines.append(f'- Source test case: {run.get("source_test_case", "n/a")}')
        lines.append(f'- Virtual users: **{run["vus"]}**')
        lines.append(f'- Duration: **{run["duration_min"]} min** ({run["duration_note"]})')
        lines.append(f'- Load profile: **{run["load_profile"]}** (from ReadyAPI {run["source_kind"]})')
        lines.append('')
        suffix = '' if cfg.get('pass_if') else '   # suggested default — no ReadyAPI threshold mapped'
        cmd = cli_command(run, pass_if, collection_uid='<COLLECTION_UID>')
        lines.append('```bash')
        lines.append(cmd + suffix)
        lines.append('```')
        lines.append('')
        if run.get('notes'):
            lines.append('Notes for this run:')
            for n in run['notes']:
                lines.append(f'- {n}')
            lines.append('')
    if cfg.get('data_files'):
        lines.append('## Data files')
        lines.append('')
        lines.append('Export each ReadyAPI DataSource to CSV/JSON and pass it to the run with '
                     '`--data-file <file>` (CLI) or `--dataset <DATASET_UID>` (cloud). Columns '
                     'are read in scripts via `pm.iterationData.get("<column>")`.')
        lines.append('')
        for df in cfg['data_files']:
            cols = ', '.join(df.get('columns', [])) or '(unknown)'
            lines.append(f'- `{df.get("filename", "data")}` — columns: {cols}')
        lines.append('')
    if cfg.get('notes'):
        lines.append('## Notes')
        for n in cfg['notes']:
            lines.append(f'- {n}')
        lines.append('')
    return '\n'.join(lines)


# ===========================================================================
# REPORT
# ===========================================================================

def _count(items):
    """(requests, folders) over the folder/item tree."""
    reqs = folders = 0
    for it in items:
        if 'item' in it:  # folder
            r, f = _count(it['item'])
            folders += 1 + f
            reqs += r
        else:
            reqs += 1
    return reqs, folders


def render_report(plan, perf):
    reqs, folders = _count(plan['folders'])
    n_vars = len(plan['variables'])
    n_lt = len(perf['runs'])
    tasks = plan['manual_tasks']
    warnings = plan['warnings']

    L = [f'# ReadyAPI -> Postman conversion: {plan["name"]}', '']
    L += ['## Summary', '',
          f'- Folders: {folders}',
          f'- Requests: {reqs}',
          f'- Variables: {n_vars}',
          f'- Load tests: {n_lt}',
          f'- Manual tasks: {len(tasks)}',
          f'- Warnings: {len(warnings)}', '']

    L += ['## Converted', '',
          '- REST request steps -> requests (method resolved from the interface, URL, query/path params, body).',
          '- Interface-method schema defaults backfill blank step query params.',
          '- SOAP (WSDL) request steps -> POST requests; Content-Type is SOAP-version aware '
          '(text/xml for 1.1, application/soap+xml for 1.2) (+ SOAPAction header when present).',
          '- Basic auth -> Postman basic auth; "No Authorization" -> noauth; inherited auth left to the parent.',
          '- Deterministic request assertions (status codes, Simple Contains/NotContains, Response SLA) -> pm.test.',
          '- Simple JSONPath assertions (JsonPath Match/Count) -> pm.expect on pm.response.json() (complex paths stay manual).',
          '- Property Transfer steps with a simple JSONPath source -> pm.collectionVariables.set in the source request.',
          '- DataSource steps -> perf data files (columns map to pm.iterationData.get(...)).',
          '- WS-Security UsernameToken -> collection-level CryptoJS pre-request building {{WSSE_HEADER}}.',
          '- Project/TestSuite/TestCase properties -> collection variables.',
          '- ReadyAPI ${...} variable references -> {{var}} (scope/step prefix stripped); known ${=...} '
          'dynamic expressions -> {{$timestamp}}/{{$guid}}/{{$isoTimestamp}}.', '']

    L += ['## Approximated', '',
          '- LoadTests -> Postman performance runs: VU count + duration + one of 4 load profiles '
          '(ReadyAPI custom strategies map to the closest profile; see perf notes).',
          '- Run COUNT / run-until-stopped limits -> a duration in minutes.',
          '- Multiple load-test assertions collapse to a single `--pass-if`; the rest become perf notes.',
          '- Property scopes (Project/TestSuite/TestCase) flattened into one variable namespace.', '']

    L += ['## Needs manual work', '']
    if tasks:
        for t in tasks:
            L.append(f'- **[{t["kind"]}]** `{t.get("request", "")}`: {t.get("detail", "")}')
    else:
        L.append('- None')
    L.append('')

    L += ['## Not supported / skipped', '']
    if warnings:
        for w in warnings:
            L.append(f'- {w}')
    else:
        L.append('- None')
    L.append('')
    return '\n'.join(L)


def _folders_summary(folders):
    """Compact folder tree summary for the IR JSON report."""
    out = []
    for f in folders:
        if 'item' in f:
            out.append({'name': f['name'],
                        'items': [c['name'] for c in f['item']],
                        'children': _folders_summary([c for c in f['item'] if 'item' in c])})
    return out


# ===========================================================================
# MAIN
# ===========================================================================

def main():
    ap = argparse.ArgumentParser(description='Convert a ReadyAPI/SoapUI project to a Postman collection + perf config.')
    ap.add_argument('input', help='path to the ReadyAPI .xml project file')
    ap.add_argument('-o', '--outdir', default='.', help='output directory')
    ap.add_argument('--json-report', action='store_true', help='also emit the raw IR as <name>.ir.json')
    args = ap.parse_args()

    try:
        plan = parse_project(args.input)
    except ET.ParseError as e:
        print(f'ERROR  {args.input}: malformed ReadyAPI XML — {e}', file=sys.stderr)
        sys.exit(2)
    except (ValueError, KeyError) as e:
        print(f'ERROR  {args.input}: could not convert — {e}', file=sys.stderr)
        sys.exit(2)

    base = os.path.splitext(os.path.basename(args.input))[0]
    os.makedirs(args.outdir, exist_ok=True)

    collection = build_collection(plan)
    perf = build_perf(plan['load_tests'])
    # Surface ReadyAPI DataSources as perf data files (columns -> pm.iterationData).
    if plan.get('datasets'):
        perf['data_files'] = [{'filename': d['filename'], 'columns': d['columns']}
                              for d in plan['datasets']]

    coll_path = os.path.join(args.outdir, f'{base}.postman_collection.json')
    with open(coll_path, 'w') as f:
        json.dump(collection, f, indent=2)

    perf_json_path = os.path.join(args.outdir, f'{base}.perf.json')
    with open(perf_json_path, 'w') as f:
        json.dump(perf, f, indent=2)

    perf_md_path = os.path.join(args.outdir, f'{base}.perf.md')
    with open(perf_md_path, 'w') as f:
        f.write(render_perf_md(perf, os.path.basename(coll_path)))

    report_path = os.path.join(args.outdir, f'{base}.report.md')
    with open(report_path, 'w') as f:
        f.write(render_report(plan, perf))

    # The IR is always useful, so we write it regardless of --json-report (the flag
    # stays in the CLI for parity with the JMeter skill and for explicit opt-in).
    ir_path = os.path.join(args.outdir, f'{base}.ir.json')
    ir = {
        'collection_name': plan['name'],
        'variables': plan['variables'],
        'folders': _folders_summary(plan['folders']),
        'manual_tasks': plan['manual_tasks'],
        'warnings': plan['warnings'],
        'load_tests': plan['load_tests'],
        'datasets': plan.get('datasets', []),
    }
    with open(ir_path, 'w') as f:
        json.dump(ir, f, indent=2)

    print(f'OK  {args.input}')
    print(f'    collection : {coll_path}')
    print(f'    perf.json  : {perf_json_path}')
    print(f'    perf.md    : {perf_md_path}')
    print(f'    report.md  : {report_path}')
    print(f'    ir.json    : {ir_path}')
    print(f'    folders={_count(plan["folders"])[1]} requests={_count(plan["folders"])[0]} '
          f'vars={len(plan["variables"])} loadtests={len(perf["runs"])} '
          f'manual_tasks={len(plan["manual_tasks"])} warnings={len(plan["warnings"])}')


if __name__ == '__main__':
    main()
