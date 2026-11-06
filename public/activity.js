export const ACTIVITY_SCHEMA = "topiaforge.activity/2";
const validBand = (band, width, maximum) =>
  band && Number.isSafeInteger(band.min) && band.min >= width &&
  band.min <= maximum && band.min % width === 0 &&
  band.max === band.min + width - 1;
export function publicActivity(value) {
  if (!value || value.schema !== ACTIVITY_SCHEMA || value.scope !== "public" ||
      !Number.isSafeInteger(value.sampledAt) || value.sampledAt % 300 !== 0 ||
      !["available", "suppressed", "unavailable"].includes(value.state)) return null;
  if (value.state === "available") {
    if (!validBand(value.sessionsBand, 5, 1e7) ||
        !validBand(value.playersBand, 10, 1e9)) return null;
  } else if (value.sessionsBand !== null || value.playersBand !== null) return null;
  return {
    schema: ACTIVITY_SCHEMA, scope: "public", sampledAt: value.sampledAt,
    state: value.state,
    sessionsBand: value.sessionsBand && { min: value.sessionsBand.min, max: value.sessionsBand.max },
    playersBand: value.playersBand && { min: value.playersBand.min, max: value.playersBand.max },
  };
}
export const bandText = (band) => band == null ? "—" : `${band.min.toLocaleString()}–${band.max.toLocaleString()}`;
