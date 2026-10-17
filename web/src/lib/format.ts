export const plural = (count: number, word: string) => `${count.toLocaleString()} ${word}${count === 1 ? "" : "s"}`

export const bytes = (count?: number) =>
  count === undefined
    ? ""
    : count < 1024
      ? `${count} B`
      : count < 1024 ** 2
        ? `${(count / 1024).toFixed(1)} KB`
        : `${(count / 1024 ** 2).toFixed(1)} MB`
