import { PayPalAgentToolkit } from "@paypal/agent-toolkit/ai-sdk";

interface Env {
  PAYPAL_CLIENT_ID: string;
  PAYPAL_CLIENT_SECRET: string;
}

export default {
  async fetch(_req: Request, env: Env): Promise<Response> {
    const out: {
      tools: string[];
      call: { ok: boolean; status?: string; id?: string; error?: string };
    } = { tools: [], call: { ok: false } };
    try {
      const toolkit = new PayPalAgentToolkit({
        clientId: env.PAYPAL_CLIENT_ID,
        clientSecret: env.PAYPAL_CLIENT_SECRET,
        configuration: {
          actions: { orders: { create: true, get: true } },
          context: { sandbox: true },
        },
      });
      const tools = toolkit.getTools() as Record<string, any>;
      out.tools = Object.keys(tools);
      const createName = out.tools.find((n) => /create.*order/.test(n));
      const getName = out.tools.find((n) => /get.*order|order.*get|show.*order/.test(n));
      if (!createName || !getName) throw new Error(`tool names not found: ${out.tools.join(",")}`);
      const created = await tools[createName].execute(
        {
          currencyCode: "USD",
          items: [{ itemCost: 1, name: "spike", quantity: 1, itemTotal: 1, taxPercent: 0 }],
          discount: 0,
          shippingCost: 0,
          shippingDiscount: 0,
          taxPercent: 0,
          intent: "CAPTURE",
        },
        { toolCallId: "t1", messages: [] },
      );
      const createdStr = typeof created === "string" ? created : JSON.stringify(created);
      const id = /"id"\s*:\s*"([A-Z0-9]+)"/.exec(createdStr)?.[1];
      if (!id) throw new Error("create returned no id: " + createdStr.slice(0, 200));
      const got = await tools[getName].execute({ id }, { toolCallId: "t2", messages: [] });
      const gotStr = typeof got === "string" ? got : JSON.stringify(got);
      out.call = {
        ok: true,
        id,
        status: /"status"\s*:\s*"([A-Z_]+)"/.exec(gotStr)?.[1],
      };
    } catch (e) {
      out.call = { ok: false, error: String((e as Error)?.message ?? e).slice(0, 400) };
    }
    return Response.json(out);
  },
};
