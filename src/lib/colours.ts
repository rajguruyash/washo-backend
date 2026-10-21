/** The colours people name most often. Anything else can be typed. */
export const COLOURS = ['White', 'Black', 'Silver', 'Grey', 'Red', 'Blue', 'Brown', 'Green'] as const;

/** A vehicle saved before WASHO asked for the colour has none: the Vehicles page reminds the customer (and nowhere else does). */
export const missingColour = (v: { color?: string | null }): boolean => !v.color?.trim();
