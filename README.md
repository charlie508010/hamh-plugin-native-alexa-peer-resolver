# HAMH Native Alexa Peer Resolver

Importierbares HAMH-Plugin zur Alexa-Geräteerkennung ohne gespeicherte Amazon-Zugangsdaten.

## Verwendung

1. In HAMH unter `Plugins` die erzeugte `.tgz` hochladen.
2. Im Plugin `Amazon Login` öffnen.
3. Im Browser bei Amazon anmelden.
4. Danach `Scan Alexa Devices` ausführen.

Das Plugin speichert den Cookie-Jar lokal unter `/config/data/sqlite/alexa-cookie.json` und eine Kompatibilitätskopie unter `/config/data/alexa-cookie.json`. Cookies, Tokens und CSRF-Werte werden nicht geloggt.

## Erzeugte Dateien

- `/config/data/sqlite/alexa-login-status.json`
- `/config/data/sqlite/alexa-cookie.json`
- `/config/data/alexa-cookie.json`
- `/config/data/sqlite/alexa-devices.json`
- `/config/data/sqlite/alexa-peer-map.json`
- `/config/data/alexa-peer-map.json`

## Konfiguration

- `enabled`: Plugin aktivieren
- `amazonDomain`: Amazon-Domain fuer Login
- `alexaHost`: Alexa-Web-API Host
- `proxyHost`: Host/IP fuer Browser-Popup
- `proxyPort`: lokaler Proxy-Port
- `scanInterval`: Scan-Intervall in Minuten
