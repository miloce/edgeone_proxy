/**
 * EdgeOne Pages proxy function.
 *
 * Fixes `Proxy Error: net_exception_peer_error` by removing the unstable
 * third-party public proxy and fetching the target URL directly.
 */
export async function onRequest(context) {
    const { request } = context;

    if (request.method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
                'Access-Control-Allow-Headers': '*',
            },
        });
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
            return new Response("Invalid target URL.", { status: 400 });
        }

        if (!['http:', 'https:'].includes(targetUrl.protocol)) {
            return new Response("Only http and https protocols are supported.", { status: 400 });
        }

        // Keep original request as-is as much as possible.
        // Only `host` must be removed so runtime can set the correct upstream host.
        const outgoingHeaders = new Headers(request.headers);
        outgoingHeaders.delete('host');

        const modifiedRequest = new Request(targetUrl.href, {
            headers: outgoingHeaders,
            method: request.method,
            body: (request.method !== 'GET' && request.method !== 'HEAD') ? request.body : null,
            redirect: 'manual'
        });

        const response = await fetch(modifiedRequest);

        const finalHeaders = new Headers(response.headers);
        // Preserve origin Domain/Path and every Set-Cookie header for the client's CookieJar.
        const location = response.headers.get('Location');
        if (location && response.status >= 300 && response.status < 400) {
            const redirectUrl = new URL(request.url);
            redirectUrl.searchParams.set('url', new URL(location, targetUrl).href);
            finalHeaders.set('Location', redirectUrl.href);
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