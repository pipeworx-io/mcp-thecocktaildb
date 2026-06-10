interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * TheCocktailDB MCP.
 *
 * Cocktail & drink recipe database — search by name, look up full recipes,
 * filter by ingredient/category/glass/alcoholic content, and list options.
 * Keyless (uses TheCocktailDB's public test API key "1").
 */


const BASE = 'https://www.thecocktaildb.com/api/json/v1/1';
const UA = 'pipeworx/1.0 (+https://pipeworx.io)';

const LIST_TYPES: Record<string, { param: string; field: string }> = {
  categories: { param: 'c', field: 'strCategory' },
  glasses: { param: 'g', field: 'strGlass' },
  ingredients: { param: 'i', field: 'strIngredient1' },
  alcoholic: { param: 'a', field: 'strAlcoholic' },
};

const tools: McpToolExport['tools'] = [
  {
    name: 'search_cocktails',
    description:
      'Search cocktails/drinks by name (or partial name) in TheCocktailDB. Returns matching drinks with category, glass, ingredients (name + measure), thumbnail, and a short instruction preview. Keyless.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Drink name or partial name, e.g. "margarita", "mojito", "gin".',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_cocktail',
    description:
      'Get the full recipe for a single cocktail by its TheCocktailDB id (idDrink). Returns complete instructions, all ingredients with measures, glass, tags, and IBA classification. Keyless.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'TheCocktailDB drink id (idDrink), e.g. "11007".' },
      },
      required: ['id'],
    },
  },
  {
    name: 'filter_cocktails',
    description:
      'Filter cocktails by exactly ONE criterion: ingredient, category, alcoholic content, or glass. Returns a light list of matching drinks (id, name, thumbnail). Provide only one filter; priority is ingredient > category > alcoholic > glass. Keyless.',
    inputSchema: {
      type: 'object',
      properties: {
        ingredient: { type: 'string', description: 'Ingredient name, e.g. "Vodka", "Gin", "Lime".' },
        category: { type: 'string', description: 'Category, e.g. "Ordinary Drink", "Cocktail".' },
        alcoholic: {
          type: 'string',
          description: 'Alcoholic content, e.g. "Alcoholic" or "Non_Alcoholic".',
        },
        glass: { type: 'string', description: 'Glass type, e.g. "Cocktail glass", "Highball glass".' },
      },
    },
  },
  {
    name: 'list_options',
    description:
      'List the available filter values for a given type. Use these to discover valid inputs for filter_cocktails. Keyless.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: 'One of: "categories", "glasses", "ingredients", "alcoholic".',
        },
      },
      required: ['type'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    switch (name) {
      case 'search_cocktails':
        return searchCocktails(args);
      case 'get_cocktail':
        return getCocktail(args);
      case 'filter_cocktails':
        return filterCocktails(args);
      case 'list_options':
        return listOptions(args);
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

type RawDrink = Record<string, unknown>;

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** Zip strIngredientN + strMeasureN into a clean ingredients array. */
function ingredients(raw: RawDrink): Array<{ name: string; measure: string | null }> {
  const out: Array<{ name: string; measure: string | null }> = [];
  for (let i = 1; i <= 15; i++) {
    const name = str(raw[`strIngredient${i}`]);
    if (!name) continue;
    out.push({ name, measure: str(raw[`strMeasure${i}`]) });
  }
  return out;
}

function compactDrink(raw: RawDrink, opts: { full?: boolean } = {}): Record<string, unknown> {
  const instructions = str(raw.strInstructions);
  const drink: Record<string, unknown> = {
    id: raw.idDrink ?? null,
    name: raw.strDrink ?? null,
    category: raw.strCategory ?? null,
    alcoholic: raw.strAlcoholic ?? null,
    glass: raw.strGlass ?? null,
    thumbnail: raw.strDrinkThumb ?? null,
    ingredients: ingredients(raw),
    instructions:
      opts.full || !instructions || instructions.length <= 500
        ? instructions
        : `${instructions.slice(0, 500)}…`,
  };
  if (opts.full) {
    const tags = str(raw.strTags);
    drink.tags = tags ? tags.split(',').map((t) => t.trim()).filter(Boolean) : [];
    const iba = str(raw.strIBA);
    if (iba) drink.iba = iba;
  }
  return drink;
}

async function fetchJson(url: string): Promise<{ drinks: RawDrink[] | null } | { error: string }> {
  const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': UA } });
  if (!res.ok) return { error: `thecocktaildb: ${res.status} ${(await res.text()).slice(0, 200)}` };
  const data = (await res.json()) as { drinks?: RawDrink[] | null };
  return { drinks: Array.isArray(data.drinks) ? data.drinks : null };
}

async function searchCocktails(args: Record<string, unknown>): Promise<unknown> {
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  if (!name) return { error: 'provide a drink name', name: args.name ?? null };

  const data = await fetchJson(`${BASE}/search.php?s=${encodeURIComponent(name)}`);
  if ('error' in data) return data;
  const drinks = data.drinks ?? [];
  const cocktails = drinks.slice(0, 25).map((d) => compactDrink(d));
  return { count: cocktails.length, cocktails };
}

async function getCocktail(args: Record<string, unknown>): Promise<unknown> {
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  if (!id) return { error: 'provide a drink id', id: args.id ?? null };

  const data = await fetchJson(`${BASE}/lookup.php?i=${encodeURIComponent(id)}`);
  if ('error' in data) return data;
  const drinks = data.drinks ?? [];
  if (drinks.length === 0) return { error: 'cocktail not found', id };
  return compactDrink(drinks[0], { full: true });
}

async function filterCocktails(args: Record<string, unknown>): Promise<unknown> {
  const ingredient = typeof args.ingredient === 'string' ? args.ingredient.trim() : '';
  const category = typeof args.category === 'string' ? args.category.trim() : '';
  const alcoholic = typeof args.alcoholic === 'string' ? args.alcoholic.trim() : '';
  const glass = typeof args.glass === 'string' ? args.glass.trim() : '';

  let qs: string;
  if (ingredient) qs = `i=${encodeURIComponent(ingredient)}`;
  else if (category) qs = `c=${encodeURIComponent(category)}`;
  else if (alcoholic) qs = `a=${encodeURIComponent(alcoholic)}`;
  else if (glass) qs = `g=${encodeURIComponent(glass)}`;
  else return { error: 'provide one of: ingredient, category, alcoholic, glass' };

  const data = await fetchJson(`${BASE}/filter.php?${qs}`);
  if ('error' in data) return data;
  const drinks = data.drinks ?? [];
  const cocktails = drinks.slice(0, 50).map((d) => ({
    id: d.idDrink ?? null,
    name: d.strDrink ?? null,
    thumbnail: d.strDrinkThumb ?? null,
  }));
  return { count: cocktails.length, cocktails };
}

async function listOptions(args: Record<string, unknown>): Promise<unknown> {
  const type = typeof args.type === 'string' ? args.type.trim().toLowerCase() : '';
  const spec = LIST_TYPES[type];
  if (!spec) {
    return { error: `provide a valid type: ${Object.keys(LIST_TYPES).join(', ')}`, type: args.type ?? null };
  }

  const data = await fetchJson(`${BASE}/list.php?${spec.param}=list`);
  if ('error' in data) return data;
  const drinks = data.drinks ?? [];
  const values = drinks.map((d) => d[spec.field]).filter((v): v is string => typeof v === 'string' && v.trim() !== '');
  return { type, count: values.length, values };
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
