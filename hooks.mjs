import { createPlugin } from './lib/plugin.mjs';

const plugin = createPlugin();

export const onRequest = (body, ctx) => plugin.onRequest(body, ctx);
export const onResponse = (reply, ctx) => plugin.onResponse(reply, ctx);
