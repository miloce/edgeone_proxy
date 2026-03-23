/**
 * EdgeOne Pages proxy function.
 *
 * Fixes `Proxy Error: net_exception_peer_error` by removing the unstable
 * third-party public proxy and fetching the target URL directly.
 */
export async function onRequest(context) {
    const { request } = context;

    const rewriteSetCookieForProxyHost = (setCookie) => {
        if (!setCookie) return setCookie;
        // Remove upstream Domain so cookie binds to proxy host and can be sent back on next request.
        return setCookie
            .replace(/;\s*Domain=[^;]*/gi, '')
            .replace(/;\s*domain=[^;]*/gi, '');
    };

    const getSetCookieValues = (headers) => {
        if (headers && typeof headers.getSetCookie === 'function') {
            try {
                const values = headers.getSetCookie();
                if (Array.isArray(values) && values.length > 0) {
                    return values;
                }
            } catch (_) {
                // fallback below
            }
        }
        const raw = headers.get('set-cookie');
        return raw ? [raw] : [];
    };

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
            return new Response("Invalid target URL.", { status: 400 });
        }

        if (!['http:', 'https:'].includes(targetUrl.protocol)) {
            return new Response("Only http and https protocols are supported.", { status: 400 });
        }

        const outgoingHeaders = new Headers(request.headers);
        outgoingHeaders.delete('host');
        outgoingHeaders.delete('cf-connecting-ip');
        outgoingHeaders.delete('cdn-loop');
        outgoingHeaders.set('origin', targetUrl.origin);
        outgoingHeaders.set('referer', targetUrl.href);

        const modifiedRequest = new Request(targetUrl.href, {
            headers: outgoingHeaders,
            method: request.method,
            body: (request.method === 'POST' || request.method === 'PUT') ? request.body : null,
            redirect: 'follow'
        });

        const response = await fetch(modifiedRequest);

        const finalHeaders = new Headers(response.headers);
        finalHeaders.delete('Set-Cookie');
        const upstreamCookies = getSetCookieValues(response.headers);
        for (const item of upstreamCookies) {
            const rewritten = rewriteSetCookieForProxyHost(item);
            if (rewritten) {
                finalHeaders.append('Set-Cookie', rewritten);
            }
        }
        finalHeaders.set('Access-Control-Allow-Origin', '*');
        finalHeaders.set('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
        finalHeaders.set('Access-Control-Allow-Headers', '*');

        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: finalHeaders
        });

    } catch (error) {
        const details = error && typeof error === 'object'
            ? `${error.name || 'Error'}: ${error.message || 'Unknown error'}`
            : String(error);

        return new Response(`Proxy Error: ${details}`, { status: 500 });
    }
}