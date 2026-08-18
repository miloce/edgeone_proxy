const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Expose-Headers': 'X-Proxy-Set-Cookie,X-Proxy-Redirect-Url',
};

const TARGET_HEADER = 'X-Proxy-Target-Url';
const REDIRECT_HEADER = 'X-Proxy-Redirect-Url';

function rewriteSetCookieForProxyHost(setCookie) {
    if (!setCookie) return setCookie;
    return setCookie
        .replace(/;\s*Domain=[^;]*/gi, '')
        .replace(/;\s*Path=[^;]*/gi, '')
        .concat('; Path=/');
}

function rewriteLocation(location, targetUrl, proxyUrl) {
    if (!location) return location;
    const nextTarget = new URL(location, targetUrl);
    const nextProxy = new URL('/proxy', proxyUrl);
    nextProxy.searchParams.set('url', nextTarget.href);
    return nextProxy.href;
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
        TARGET_HEADER.toLowerCase(),
    ]) {
        headers.delete(name);
    }
    for (const name of [...headers.keys()]) {
        if (name.startsWith('eo-') || name.startsWith('cdn-')) {
            headers.delete(name);
        }
    }
}

function stripResponseHeaders(headers) {
    for (const name of [
        'connection',
        'content-encoding',
        'content-length',
        'keep-alive',
        'proxy-authenticate',
        'te',
        'trailer',
        'transfer-encoding',
        'upgrade',
    ]) {
        headers.delete(name);
    }
}

function getSetCookieValues(headers) {
    if (headers && typeof headers.getSetCookie === 'function') {
        const values = headers.getSetCookie();
        if (Array.isArray(values) && values.length > 0) return values;
    }
    const raw = headers.get('set-cookie');
    return raw ? [raw] : [];
}

export async function onRequest(context) {
    const { request } = context;
    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
        const requestUrl = new URL(request.url);
        const headerTarget = request.headers.get(TARGET_HEADER);
        const targetUrlParam = headerTarget || requestUrl.searchParams.get('url');
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
        const outgoingHeaders = new Headers(request.headers);
        stripRequestHeaders(outgoingHeaders);
        outgoingHeaders.set('Accept-Encoding', 'identity');

        const response = await fetch(new Request(targetUrl.href, {
            headers: outgoingHeaders,
            method: request.method,
            body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : null,
            redirect: 'manual',
        }));

        const finalHeaders = new Headers(response.headers);
        stripResponseHeaders(finalHeaders);
        finalHeaders.delete('Set-Cookie');
        const upstreamCookies = getSetCookieValues(response.headers);
        for (const item of upstreamCookies) {
            const rewritten = rewriteSetCookieForProxyHost(item);
            if (rewritten) finalHeaders.append('Set-Cookie', rewritten);
        }
        if (upstreamCookies.length > 0) {
            finalHeaders.set('X-Proxy-Set-Cookie', encodeURIComponent(JSON.stringify(upstreamCookies)));
        }
        const location = response.headers.get('location');
        if (location) {
            const redirectTarget = new URL(location, targetUrl).href;
            if (headerTarget) {
                finalHeaders.set(REDIRECT_HEADER, redirectTarget);
                finalHeaders.set('Location', new URL('/proxy', request.url).href);
            } else {
                finalHeaders.set('Location', rewriteLocation(location, targetUrl, request.url));
            }
        }
        for (const [name, value] of Object.entries(CORS_HEADERS)) finalHeaders.set(name, value);

        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: finalHeaders,
        });
    } catch (error) {
        const details = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        return new Response(`Proxy Error: ${details}`, { status: 500, headers: CORS_HEADERS });
    }
}
