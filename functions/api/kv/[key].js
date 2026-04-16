const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
};
export const onRequestOptions = async () => new Response(null, { headers: CORS });
export const onRequestGet = async ({ params, env }) => {
    const key = params.key;
    const value = await env.KV.get(key);
    if (value === null)
        return new Response(null, { status: 404, headers: CORS });
    return Response.json({ value }, { headers: CORS });
};
export const onRequestPut = async ({ params, env, request }) => {
    const key = params.key;
    const { value } = await request.json();
    await env.KV.put(key, value);
    return new Response(null, { status: 204, headers: CORS });
};
