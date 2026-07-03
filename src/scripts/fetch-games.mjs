import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const STEAM_API_KEY = process.env.STEAM_API_KEY;
const STEAM_ID = process.env.STEAM_ID;
const SHEET_TSV_URL = process.env.SHEET_TSV_URL;
const STEAMGRIDDB_API_KEY = process.env.STEAMGRIDDB_API_KEY;

if (!STEAM_API_KEY || !STEAM_ID || !SHEET_TSV_URL) {
  console.error('Error: Missing required environment variables:');
  if (!STEAM_API_KEY) console.error('  - STEAM_API_KEY');
  if (!STEAM_ID) console.error('  - STEAM_ID');
  if (!SHEET_TSV_URL) console.error('  - SHEET_TSV_URL');
  process.exit(1);
}

if (!STEAMGRIDDB_API_KEY) {
  console.warn('Warning: STEAMGRIDDB_API_KEY not set, fallback covers disabled');
}

function parseGame(g) {
  return {
    appid: g.appid,
    name: g.name,
    playtime_forever: g.playtime_forever,
  };
}

async function fetchTSV() {
  console.log('Fetching TSV from Google Sheet...');
  const res = await fetch(SHEET_TSV_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch TSV: ${res.status} ${res.statusText}`);
  }
  const text = await res.text();
  const lines = text.trim().split('\n');
  if (lines.length < 2) {
    throw new Error('TSV is empty or has no data rows');
  }

  const headers = lines[0].split('\t').map(h => h.trim().toLowerCase());
  const appidIndex = headers.indexOf('appid');
  if (appidIndex === -1) {
    throw new Error('TSV missing "appid" column');
  }
  const nameIndex = headers.indexOf('name');

  const games = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t');
    const appid = parseInt(cols[appidIndex]?.trim(), 10);
    if (!isNaN(appid)) {
      const name = nameIndex !== -1 ? cols[nameIndex]?.trim() || '' : '';
      games.push({ appid, name });
    }
  }

  const unique = new Map(games.map(g => [g.appid, g]));
  if (unique.size !== games.length) {
    const dupes = games.filter((g, i) => games.findIndex(x => x.appid === g.appid) !== i).map(g => g.appid);
    console.warn(`Warning: Duplicate appids found: ${[...new Set(dupes)].join(', ')}`);
  }

  console.log(`Found ${unique.size} unique completed games in TSV`);
  return [...unique.values()];
}

async function fetchOwnedGames() {
  console.log('Fetching owned games from Steam API...');
  const url = new URL('https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/');
  url.searchParams.set('key', STEAM_API_KEY);
  url.searchParams.set('steamid', STEAM_ID);
  url.searchParams.set('include_appinfo', 'true');
  url.searchParams.set('format', 'json');

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Steam API error: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  const games = data?.response?.games || [];
  console.log(`Fetched ${games.length} owned games from Steam`);
  return games;
}

async function checkImageExists(url) {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    return res.ok;
  } catch {
    return false;
  }
}

async function fetchSteamGridCover(appid, name) {
  if (!STEAMGRIDDB_API_KEY) return null;

  try {
    const searchUrl = `https://www.steamgriddb.com/api/v2/grids/steam/${appid}?dimensions=600x900&limit=1`;
    const res = await fetch(searchUrl, {
      headers: { 'Authorization': `Bearer ${STEAMGRIDDB_API_KEY}` },
    });

    if (!res.ok) return null;

    const data = await res.json();
    if (data.success && data.data?.length > 0) {
      return data.data[0].url;
    }
    return null;
  } catch (err) {
    console.warn(`SteamGridDB error for "${name}" (appid ${appid}): ${err.message}`);
    return null;
  }
}

async function fetchGameNameFromStore(appid) {
  try {
    const res = await fetch(`https://store.steampowered.com/api/appdetails?appids=${appid}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data?.[String(appid)]?.data?.name || null;
  } catch {
    return null;
  }
}

async function resolveCoverUrl(appid, name) {
  const steamUrl = `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/library_600x900.jpg`;

  if (await checkImageExists(steamUrl)) {
    return steamUrl;
  }

  console.warn(`Steam cover 404 for "${name}" (appid ${appid}), trying SteamGridDB...`);
  const sgdbUrl = await fetchSteamGridCover(appid, name);

  if (sgdbUrl) {
    console.log(`  ✓ Found SteamGridDB cover for "${name}"`);
    return sgdbUrl;
  }

  console.warn(`  ✗ No cover found for "${name}" (appid ${appid}), using Steam URL`);
  return steamUrl;
}

function buildData(tsvGames, ownedGames) {
  const ownedMap = new Map(ownedGames.map(g => [g.appid, g]));

  const completedGames = [];
  const missingGames = [];
  for (const tsvGame of tsvGames) {
    const game = ownedMap.get(tsvGame.appid);
    if (game) {
      completedGames.push(parseGame(game));
    } else {
      const name = tsvGame.name || '';
      completedGames.push({
        appid: tsvGame.appid,
        name,
        playtime_forever: 0,
        ...(name ? {} : { _needsName: true }),
      });
      if (!name) missingGames.push(tsvGame.appid);
    }
  }

  const allGames = ownedGames.map(parseGame);
  allGames.sort((a, b) => b.playtime_forever - a.playtime_forever);

  return { topGames: allGames, completedGames, missingGames };
}

async function resolveCoverUrls(completedGames) {
  console.log('\nResolving game data...');
  for (const game of completedGames) {
    if (game._needsName) {
      console.log(`Fetching name for appid ${game.appid} from Steam Store...`);
      const name = await fetchGameNameFromStore(game.appid);
      if (name) {
        game.name = name;
        console.log(`  ✓ Found: "${name}"`);
      } else {
        game.name = `Juego ${game.appid}`;
        console.warn(`  ✗ No name found for appid ${game.appid}`);
      }
      delete game._needsName;
    }
    game.coverUrl = await resolveCoverUrl(game.appid, game.name);
  }
}

async function main() {
  try {
    const tsvGames = await fetchTSV();
    const ownedGames = await fetchOwnedGames();
    const data = buildData(tsvGames, ownedGames);

    await resolveCoverUrls(data.completedGames);
    data.completedGames.sort((a, b) => a.name.localeCompare(b.name));

    const outDir = join(__dirname, '..', 'data');
    mkdirSync(outDir, { recursive: true });
    const outPath = join(outDir, 'games.json');
    writeFileSync(outPath, JSON.stringify(data, null, 2));
    console.log(`\nGenerated ${outPath}`);
    console.log(`  - Top games (all library): ${data.topGames.length}`);
    console.log(`  - Completed games (from Sheet): ${data.completedGames.length}`);
  } catch (err) {
    console.error('Error generating games data:', err.message);
    process.exit(1);
  }
}

main();
