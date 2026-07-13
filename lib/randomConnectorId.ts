const ADJECTIVES = [
  'amber', 'brave', 'calm', 'coral', 'dusty', 'eager', 'fleet', 'gentle',
  'hazel', 'ivory', 'jolly', 'keen', 'lively', 'misty', 'nimble', 'olive',
  'plucky', 'quiet', 'rusty', 'sturdy', 'tidy', 'vivid', 'windy', 'zesty',
];

const NOUNS = [
  'otter', 'falcon', 'maple', 'harbor', 'canyon', 'ember', 'glacier', 'heron',
  'lagoon', 'meadow', 'orchard', 'pebble', 'quartz', 'ridge', 'summit', 'thicket',
  'tundra', 'valley', 'willow', 'brook', 'cove', 'dune', 'fjord', 'grove',
];

// A short, URL-safe, memorable-enough connector ID (e.g. "amber-otter").
// Meant as a sensible default the person can freely overwrite — it's not
// meaningful, just avoids the "name it right now or leave it blank" moment.
export function generateRandomConnectorId(): string {
  const adjective = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${adjective}-${noun}`;
}
