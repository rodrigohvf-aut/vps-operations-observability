import { z } from "zod";

const periodSchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  client: z.string().trim().min(1).optional()
});

export function parsePeriod(input: unknown) {
  const value = periodSchema.parse(input);
  const to = value.to ?? new Date();
  const from = value.from ?? new Date(to.getTime() - 7 * 86_400_000);
  if (from > to) throw new Error("A data inicial deve ser anterior à data final.");
  return { ...value, from, to };
}
