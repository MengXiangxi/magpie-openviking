export class ApiError extends Error {
  constructor(code) { super(code); this.code = code; }
}

export class OpenViking {
  constructor(config, fetcher = fetch) { this.config = config; this.fetcher = fetcher; }

  async request(path, payload, { signal, method = 'POST' } = {}) {
    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
    let response;
    try {
      response = await this.fetcher(`${this.config.baseUrl}${path}`, {
        method, redirect: 'error', signal: combined,
        headers: { 'X-API-Key': this.config.apiKey, 'Content-Type': 'application/json' },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) })
      });
      if (!response.ok) throw new ApiError([401, 403].includes(response.status) ? 'unauthorized' : 'unavailable');
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > 1_048_576) throw new ApiError('invalid');
        chunks.push(Buffer.from(chunk));
      }
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (data?.status !== 'ok' || !data.result || typeof data.result !== 'object') throw new ApiError('invalid');
      return data.result;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError('unavailable'); // never expose endpoint, headers, prompts or upstream error text
    }
  }

  async recall(query, excluded, signal) {
    return this.request('/api/v1/search/search', {
      mode: 'context', query, max_tokens: this.config.maxTokens,
      context_type: this.config.contextType,
      query_expansion: 'off', rewrite: false, exclude_uris: excluded.slice(-200)
    }, { signal });
  }

  async prepareSession(id, signal) {
    const path = `/api/v1/sessions/${encodeURIComponent(id)}`;
    await this.request(`${path}?auto_create=true`, undefined, { signal, method: 'GET' });
    await this.request(`${path}/config`, {
      auto_commit_policy: {
        pending_token_threshold: 20000, message_count_threshold: 40,
        idle_timeout_seconds: this.config.idleSeconds, keep_recent_count: 0,
        min_commit_interval_seconds: 0
      }
    }, { signal, method: 'PATCH' });
  }

  async append(id, event, signal) {
    return this.request(`/api/v1/sessions/${encodeURIComponent(id)}/messages/batch`, {
      messages: [
        { role: 'user', content: event.user, turn_id: event.id, message_kind: 'user_query', source_message_ids: [`${event.id}:user`] },
        { role: 'assistant', content: event.assistant, turn_id: event.id, message_kind: 'assistant_step', source_message_ids: [`${event.id}:assistant`] }
      ]
    }, { signal });
  }
}
