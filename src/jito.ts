import { config } from "./config";

interface JitoResponse {
  jsonrpc: string;
  result?: string;
  error?: unknown;
  id: number;
}

export async function sendJitoBundle(signedTransactionsBase64: string[]): Promise<string> {
  if (!config.jitoBlockEngineUrl) {
    throw new Error("JITO_BLOCK_ENGINE_URL is not configured");
  }

  const response = await fetch(config.jitoBlockEngineUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "sendBundle",
      params: [signedTransactionsBase64],
    }),
  });

  if (!response.ok) throw new Error(`Jito bundle failed ${response.status}: ${await response.text()}`);
  const body = (await response.json()) as JitoResponse;
  if (body.error) throw new Error(`Jito bundle error: ${JSON.stringify(body.error)}`);
  if (!body.result) throw new Error("Jito bundle returned no result");
  return body.result;
}
