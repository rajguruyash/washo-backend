/**
 * Woshi's pixel mascot: a little shell buddy with a sponge in one hand and a coiled hose for a tail. Flat pixel art, drawn here as rows of letters (one letter per pixel, "." is empty) so it
 * stays crisp at any size and needs no image file. Two walking frames: the legs and the bob change.
 */
export const SPRITE_WIDTH = 30;

export const BODY: string[] = [
  ".................BBBBBB.......",
  "................BBBBBBBB......",
  "...............BBBBBBBBBB.....",
  "...............BBBBBBBBBBB....",
  "...............BBBBDDBDDBB....",
  "...............BBBBDDBDDBB....",
  "...............BBBBBBBBBBB....",
  "................BBBBBBBBBB....",
  "............UUUU.BBBBBBBB.....",
  "..HHHH.....UTTTTUBBBBBBBB.....",
  ".HHhhHH...UTTWTTUBPPPPPPB..YYY",
  "HHh..hHH..UTUUUTUBPPPPPPBBBYNY",
  "HH....HH..UTTTTTUBPPPPPPB..YYY",
  "HH....HH...UTTTTUBPPPPPPB.....",
  "HHh..hHH...UUUUUUBBBBBBBB.....",
  ".HHhhHHHHHHHHHHHHBBBBBBBB.....",
];

export const LEGS: string[][] = [
  ["..HHHH............BB..BB......",
  "..................BBB.BBB....."],
  ["..HHHH.............BB...BB....",
  "..................BBB..BBB...."],
];

export const PALETTE: Record<string, string> = {"B": "#8ecdff", "P": "#e3f4ff", "D": "#0b1226", "T": "#3db9a8", "U": "#1d7f8a", "W": "#ffffff", "H": "#4f86e8", "Y": "#ffd55a", "N": "#e0a52b", "h": "#2f5fc4"};
