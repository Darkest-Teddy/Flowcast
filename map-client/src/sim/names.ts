// A first name for each simulated person, for the map's hover text. Names are the most popular
// US names for students' birth years (public/data/names.json, data-pipeline/build_names.py), and
// match the character's gender: character models 0-5 are the female Kenney characters, 6-11 the
// male ones (layers/agents.ts CHARACTER_MODELS). Within each gender every name is used equally
// often: people are taken in id order and dealt the names in turn.

export interface NameLists {
  female: string[];
  male: string[];
}

/** Character models 0-5 are female, 6-11 male (CHARACTER_MODELS order). */
export const isFemaleModel = (model: number) => ((model % 12) + 12) % 12 < 6;

export function assignNames(people: { id: string; model: number }[], names: NameLists): Map<string, string> {
  const out = new Map<string, string>();
  const byGender: [{ id: string; model: number }[], string[]][] = [
    [people.filter((p) => isFemaleModel(p.model)), names.female],
    [people.filter((p) => !isFemaleModel(p.model)), names.male],
  ];
  for (const [group, list] of byGender) {
    if (!list.length) continue;
    const sorted = [...group].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    sorted.forEach((p, i) => out.set(p.id, list[i % list.length]));
  }
  return out;
}
