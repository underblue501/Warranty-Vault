import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

export const CATEGORIES = [
  'Electronics', 'Appliances', 'Furniture', 'Tools', 'Outdoor', 'Other'
] as const;

/* A fixed schema is enforced by the API, so the response cannot come back as
   prose, a markdown fence, or JSON with the wrong shape - all of which the
   previous prompt-and-parse approach had to guess its way through. */
const ReceiptSchema = z.object({
  is_receipt: z.boolean()
    .describe('true only if this image is a purchase receipt or invoice'),
  name: z.string().nullable()
    .describe('the main purchased item, as a shopper would name it'),
  price: z.number().nullable()
    .describe('the price of that item in the receipt currency, no symbol'),
  date: z.string().nullable()
    .describe('the purchase date as YYYY-MM-DD'),
  store: z.string().nullable()
    .describe('the retailer name'),
  months: z.number().int().nullable()
    .describe('typical manufacturer warranty for this kind of product, one of 6, 12, 24, 36, 60'),
  category: z.enum(CATEGORIES).nullable()
});

export type Receipt = z.infer<typeof ReceiptSchema>;

const SYSTEM = [
  'You read photographs of purchase receipts and extract the single main purchased item.',
  'Report only what the image supports: if a field is not legible, return null for it rather than guessing.',
  'The exception is `months`, which is an estimate of the typical manufacturer warranty length',
  'for that kind of product, not something you should expect to find printed on the receipt.',
  'If the image is not a receipt or invoice, set is_receipt to false and leave every other field null.'
].join(' ');

export class ScanError extends Error {
  // A plain field rather than a TS parameter property, so the file runs under
  // type-stripping (node --experimental-strip-types) as well as through esbuild.
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ScanError';
    this.status = status;
  }
}

export interface ScanOptions {
  apiKey: string;
  model: string;
  effort: string;
  imageBase64: string;
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
}

export async function scanReceipt(opts: ScanOptions): Promise<Receipt> {
  const client = new Anthropic({ apiKey: opts.apiKey });

  try {
    const response = await client.messages.parse({
      model: opts.model,
      max_tokens: 4096,
      system: SYSTEM,
      // Thinking is adaptive by default on Opus 5; effort trades depth for
      // latency, and this is a short extraction behind a human review step.
      output_config: {
        effort: opts.effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max',
        format: zodOutputFormat(ReceiptSchema)
      },
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: opts.mediaType, data: opts.imageBase64 }
            },
            { type: 'text', text: 'Extract the main purchased item from this receipt.' }
          ]
        }
      ]
    });

    if (response.stop_reason === 'refusal') {
      throw new ScanError('that image could not be processed.', 422);
    }
    // parsed_output is null when the model could not satisfy the schema.
    if (!response.parsed_output) {
      throw new ScanError('the receipt could not be read from that image.', 422);
    }
    return response.parsed_output;
  } catch (err) {
    if (err instanceof ScanError) throw err;

    // Most specific first: never collapse retryable and non-retryable into one.
    if (err instanceof Anthropic.AuthenticationError) {
      console.error('anthropic auth failed - check the ANTHROPIC_API_KEY secret');
      throw new ScanError('the scanning service is misconfigured.', 500);
    }
    if (err instanceof Anthropic.RateLimitError) {
      throw new ScanError('the scanning service is busy. Try again in a moment.', 429);
    }
    if (err instanceof Anthropic.BadRequestError) {
      console.error('anthropic rejected the request:', err.message);
      throw new ScanError('that image could not be processed.', 400);
    }
    if (err instanceof Anthropic.APIConnectionError) {
      throw new ScanError('the scanning service could not be reached.', 502);
    }
    if (err instanceof Anthropic.APIError) {
      console.error(`anthropic error ${err.status}:`, err.message);
      throw new ScanError('the scanning service failed.', 502);
    }
    console.error('unexpected scan failure:', err);
    throw new ScanError('the scan failed unexpectedly.', 500);
  }
}

/* The browser already speaks this shape, so the Worker answers in it rather
   than making the page learn a second one. */
export function toClientShape(r: Receipt): Record<string, unknown> {
  if (!r.is_receipt) return { error: 'not a receipt' };
  return {
    name: r.name,
    price: r.price,
    date: r.date,
    store: r.store,
    months: r.months,
    category: r.category
  };
}
