/** How litevision talks to Providers. Production uses `fetch`; tests inject recorded responses. */
export type HttpTransport = (input: string, init?: RequestInit) => Promise<Response>;

export const fetchTransport: HttpTransport = (input, init) => fetch(input, init);
