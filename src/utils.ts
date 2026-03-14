export const utils = {
  ms(seconds: number) {
    return seconds * 1000;
  },
  minutes(value: number) {
    return value * 60 * 1000;
  },
  seconds(ms: number) {
    return Number((ms / 1000).toFixed(2));
  },
};
