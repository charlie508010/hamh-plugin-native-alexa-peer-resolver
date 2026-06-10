# hamh-plugin-native-alexa-peer-resolver

Resolve Alexa/Matter peer IDs to Echo device names in Home-Assistant-Matter-Hub logs.

HAMH plugin only, experimental and unmaintained.

## Purpose

This plugin is an experimental helper for Home-Assistant-Matter-Hub.

Home-Assistant-Matter-Hub logs Matter controller sessions like this:

```text
Bridge / 8~4aabdXXX Session 57225 (peer 1615190xxxx name="Raum Echo Dot"): subscriptions=0 | total: sessions=5
```

The goal of this plugin is to help map Alexa/Matter peer IDs to readable Echo device names, so HAMH logs can show which Alexa/Echo device is currently communicating with the bridge.

To do this, the plugin can start a local Amazon login proxy. The user signs in through the browser. The plugin stores the resulting Amazon cookie jar locally and uses the Alexa web API to scan Alexa devices. It can also manually fetch recent Alexa voice history for testing.

The plugin does not store Amazon email, password, or 2FA codes.

## Stored data

```text
/config/data/<file|sqlite>/alexa-login-status.json
/config/data/<file|sqlite>/alexa-cookie.json
/config/data/alexa-cookie.json
/config/data/<file|sqlite>/alexa-devices.json
/config/data/<file|sqlite>/alexa-peer-map.json
/config/data/alexa-peer-map.json
/config/data/<file|sqlite>/alexa-voice-history.json
/config/data/<file|sqlite>/alexa-voice-history-status.json
```

The plugin does not log cookies, tokens, CSRF values, passwords, 2FA codes, private keys, full request headers, or voice-history transcript text. Voice-history transcript text is stored only in the local voice-history JSON file and shown on the plugin page after the manual scan action.

This plugin works only inside the Home-Assistant-Matter-Hub plugin system. It is not a standalone Alexa integration and not a Home Assistant add-on by itself.

## Build plugin package

Clone the repository and create the upload package:

```bash
git clone https://github.com/charlie508010/hamh-plugin-native-alexa-peer-resolver.git
cd hamh-plugin-native-alexa-peer-resolver
npm install
npm pack
```

This creates a file like:

```text
hamh-plugin-native-alexa-peer-resolver-0.1.28.tgz
```

Upload this `.tgz` file in Home-Assistant-Matter-Hub:

```text
Plugins -> Upload
```

## Status

This plugin is experimental and provided as-is.

I created it for personal testing and do not currently have time to maintain it further. I do not provide support, guarantees, or warranty for this plugin.

Use at your own risk.
