# Steam

Registro de mi biblioteca de Steam. Hecho con Astro.

## Requisitos

- Node.js >= 22.12.0
- pnpm
- API key de Steam
- Cuenta de SteamGridDB (opcional)

## Variables de entorno

```
STEAM_API_KEY=
STEAM_ID=
SHEET_TSV_URL=
STEAMGRIDDB_API_KEY=
```

`SHEET_TSV_URL` es la URL de exportacion de un Google Sheet en formato TSV. La hoja debe tener una columna `appid` con los IDs de los juegos completados. La URL se obtiene desde Google Sheets > Archivo > Compartir > Publicar en la web > formato TSV.

## Desarrollo

```sh
pnpm install
pnpm run fetch
pnpm run dev
```

## Build

```sh
pnpm run build
```

El build ejecuta `fetch-games.mjs` antes de compilar. Este script obtiene los datos de Steam API y SteamSpy.
