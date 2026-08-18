import http from 'node:http';
import https from 'node:https';

const REQUEST_TIMEOUT_MS = 30000;
const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS',
    'Access-Control-Allow-Headers': '*',
};

function isChaoxingExamTransport(targetUrl) {
    const hostname = targetUrl.hostname.toLowerCase();
    if (hostname === 'captcha.chaoxing.com') return true;
    if (hostname === 'passport2.chaoxing.com') return true;
    if (hostname === 'sso.chaoxing.com') return true;
    return hostname.endsWith('.chaoxing.com') && targetUrl.pathname.startsWith('/exam-ans/');
}

function stripRequestHeaders(headers) {
    for (const name of [
        'connection',
        'content-length',
        'forwarded',
        'host',
        'keep-alive',
        'proxy-authenticate',
        'proxy-authorization',
        'te',
        'trailer',
        'transfer-encoding',
        'upgrade',
        'via',
        'x-forwarded-for',
        'x-forwarded-host',
        'x-forwarded-port',
        'x-forwarded-proto',
        'x-nws-log-uuid',
        'x-real-ip',
    ]) {
        headers.delete(name);
    }
    for (const name of [...headers.keys()]) {
        if (name.startsWith('eo-') || name.startsWith('cdn-')) {
            headers.delete(name);
        }
    }
}

function rewriteSetCookieForProxyHost(setCookie) {
    return setCookie
        .replace(/;\s*Domain=[^;]*/gi, '')
        .replace(/;\s*Path=[^;]*/gi, '')
        .concat('; Path=/');
}

function rewriteLocation(location, targetUrl, proxyUrl) {
    const nextTarget = new URL(location, targetUrl);
    const nextProxy = new URL('/proxy', proxyUrl);
    nextProxy.searchParams.set('url', nextTarget.href);
    return nextProxy.href;
}

async function readRequestBody(request) {
    if (request.method === 'GET' || request.method === 'HEAD') return null;
    const body = Buffer.from(await request.arrayBuffer());
    return body.length > 0 ? body : null;
}

function requestUpstream(targetUrl, method, headers, body) {
    const transport = targetUrl.protocol === 'https:' ? https : http;
    const agent = targetUrl.protocol === 'https:' ? httpsAgent : httpAgent;
    const requestHeaders = Object.fromEntries(headers.entries());
    if (body) requestHeaders['content-length'] = String(body.length);

    return new Promise((resolve, reject) => {
        const upstreamRequest = transport.request({
            protocol: targetUrl.protocol,
            hostname: targetUrl.hostname,
            port: targetUrl.port || undefined,
            path: `${targetUrl.pathname}${targetUrl.search}`,
            method,
            headers: requestHeaders,
            agent,
        }, (upstreamResponse) => {
            const chunks = [];
            upstreamResponse.on('data', (chunk) => chunks.push(chunk));
            upstreamResponse.on('end', () => resolve({
                status: upstreamResponse.statusCode || 502,
                statusText: upstreamResponse.statusMessage || '',
                headers: upstreamResponse.headers,
                body: Buffer.concat(chunks),
            }));
            upstreamResponse.on('error', reject);
        });
        upstreamRequest.setTimeout(REQUEST_TIMEOUT_MS, () => {
            upstreamRequest.destroy(new Error('Upstream request timed out'));
        });
        upstreamRequest.on('error', reject);
        if (body) upstreamRequest.write(body);
        upstreamRequest.end();
    });
}

function buildResponseHeaders(upstreamHeaders, targetUrl, proxyUrl) {
    const headers = new Headers();
    for (const [name, value] of Object.entries(upstreamHeaders)) {
        if (value == null) continue;
        const lowerName = name.toLowerCase();
        if (['connection', 'content-length', 'keep-alive', 'transfer-encoding'].includes(lowerName)) continue;
        if (lowerName === 'set-cookie') {
            for (const cookie of Array.isArray(value) ? value : [value]) {
                headers.append('Set-Cookie', rewriteSetCookieForProxyHost(cookie));
            }
            continue;
        }
        if (lowerName === 'location') {
            headers.set('Location', rewriteLocation(Array.isArray(value) ? value[0] : value, targetUrl, proxyUrl));
            continue;
        }
        headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    }
    for (const [name, value] of Object.entries(CORS_HEADERS)) headers.set(name, value);
    return headers;
}

export async function onRequest(context) {
    const { request } = context;
    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
        const requestUrl = new URL(request.url);
        const targetUrlParam = requestUrl.searchParams.get('url');
        if (!targetUrlParam) {
            return new Response("Query parameter 'url' is missing.", { status: 400 });
        }

        let targetUrl;
        try {
            targetUrl = new URL(targetUrlParam);
        } catch {
            return new Response('Invalid target URL.', { status: 400 });
        }
        if (!['http:', 'https:'].includes(targetUrl.protocol)) {
            return new Response('Only http and https protocols are supported.', { status: 400 });
        }
        if (!isChaoxingExamTransport(targetUrl)) {
            return new Response('Target is not part of the Chaoxing exam transport.', { status: 403 });
        }

        const outgoingHeaders = new Headers(request.headers);
        stripRequestHeaders(outgoingHeaders);
        const body = await readRequestBody(request);
        const upstream = await requestUpstream(targetUrl, request.method, outgoingHeaders, body);
        const responseBody = request.method === 'HEAD' || [204, 304].includes(upstream.status)
            ? null
            : upstream.body;

        return new Response(responseBody, {
            status: upstream.status,
            statusText: upstream.statusText,
            headers: buildResponseHeaders(upstream.headers, targetUrl, request.url),
        });
    } catch (error) {
        const details = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        return new Response(`Proxy Error: ${details}`, { status: 502, headers: CORS_HEADERS });
    }
}
