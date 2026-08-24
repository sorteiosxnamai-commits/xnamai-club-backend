import { Router } from 'express';
import { z } from 'zod';

export const webhooksRouter = Router();

// Provider-agnostic placeholder. Replace validation and event mapping when the real gateway is chosen.
webhooksRouter.post('/payment-provider', async (req, res) => {
  const parsed = z.object({ type: z.string(), id: z.string().optional(), data: z.unknown().optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Webhook inválido.' });

  console.info('[webhook-demo]', parsed.data.type, parsed.data.id ?? 'no-id');
  res.status(200).json({ received: true });
});
