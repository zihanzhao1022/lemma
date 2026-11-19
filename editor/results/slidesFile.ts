/**
 * An HTML deck's own file in the papers repository. The deck is HTML, so it is kept as a file of its own and not in
 * results.json: its history reads as lines, and the list of papers does not carry every deck's size.
 */
export const slidesPath = (paperId: string): string => `results/${paperId}/slides.html`;
