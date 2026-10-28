export class ApiError extends Error {
  constructor(code) { super(code); this.code = code; }
}

export class OpenViking {
  constructor(config, fetcher = fetch) { this.config = config; this.fetcher = fetcher; }

  async request(path, payload, { signal, method = 'POST', timeoutMs } = {}) {
    const timeout = AbortSignal.timeout(timeoutMs ?? this.config.timeoutMs);
    const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
    let response;
    try {
      response = await this.fetcher(`${this.config.baseUrl}${path}`, {
        method, redirect: 'error', signal: combined,
        headers: { 'X-API-Key': this.config.apiKey, 'Content-Type': 'application/json' },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) })
      });
      if (!response.ok) {
        // 4xx means the request shape/endpoint is wrong (for example an API
        // missing on this server version); 5xx and throttling are transient.
        const status = response.status;
        const code = [401, 403].includes(status) ? 'unauthorized'
          : [408, 429].includes(status) || status >= 500 ? 'unavailable'
          : status >= 400 ? 'invalid' : 'unavailable';
        throw new ApiError(code);
      }
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

  // One remember event is its own throw-away session, so extraction sees exactly
  // that statement instead of an aggregated conversation. The batch endpoint
  // auto-creates a missing session, so there is no separate create call.
  async appendRemember(event, signal) {
    return this.request(`/api/v1/sessions/${encodeURIComponent(event.ovSession)}/messages/batch`, {
      messages: event.messages.map((message, index) => ({
        role: message.role,
        content: message.content,
        turn_id: event.id,
        message_kind: message.role === 'user' ? 'user_query' : 'assistant_step',
        source_message_ids: [`${event.id}:${message.role}:${index}`]
      }))
    }, { signal, timeoutMs: this.config.rememberTimeoutMs });
  }

  // Archiving completes before the response; extraction keeps running server-side.
  // Re-calling commit on a session with nothing left to archive is a no-op reason,
  // which makes retrying a failed commit safe.
  async commitRemember(event, signal) {
    const result = await this.request(`/api/v1/sessions/${encodeURIComponent(event.ovSession)}/commit`,
      { keep_recent_count: 0 }, { signal, timeoutMs: this.config.rememberTimeoutMs });
    return {
      taskId: typeof result?.task_id === 'string' ? result.task_id : null,
      // "skipped / no_messages" right after our own append means the batch never
      // landed; after a crash it means the commit already happened.
      skipped: result?.status === 'skipped',
      reason: typeof result?.reason === 'string' ? result.reason : null
    };
  }

  async sessionStats(id, signal) {
    return this.request(`/api/v1/stats/sessions/${encodeURIComponent(id)}`, undefined,
      { signal, method: 'GET', timeoutMs: this.config.rememberTimeoutMs });
  }
}
