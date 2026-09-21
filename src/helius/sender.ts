import { Agent, request } from "undici";
export interface SenderTiming { signalMonoMs: number; sendStartMonoMs: number; responseMonoMs: number; }
export class HeliusSender {
  readonly #agent = new Agent({ connections: 8, pipelining: 1, keepAliveTimeout: 60_000 });
  constructor(private readonly url: string, private readonly swqosOnly: boolean, private readonly liveEnabled = false) {}
  async send(base64Transaction: string, signalMonoMs: number): Promise<{ signature: string; timing: SenderTiming }> {
    if (!this.liveEnabled) throw new Error("LIVE_SUBMISSION_BLOCKED: EXECUTION_MODE is not live");
    const sendStartMonoMs = performance.now();
    const url = new URL(this.url); url.searchParams.set("swqos_only", String(this.swqosOnly));
    const body = `{"jsonrpc":"2.0","id":1,"method":"sendTransaction","params":["${base64Transaction}",{"encoding":"base64","skipPreflight":true,"maxRetries":0}]}`;
    const response = await request(url, { method: "POST", body, dispatcher: this.#agent, headers: { "content-type": "application/json" } });
    const json = await response.body.json() as { result?: string; error?: { message: string } };
    const responseMonoMs = performance.now();
    if (!json.result) throw new Error(`Helius Sender rejected transaction: ${json.error?.message ?? response.statusCode}`);
    return { signature: json.result, timing: { signalMonoMs, sendStartMonoMs, responseMonoMs } };
  }
  async close(): Promise<void> { await this.#agent.close(); }
}
