# Bitford

A BitTorrent client as a Chrome Packaged App.

Contrary to other implementations, this one talks the native
BitTorrent protocol 100% in JavaScript.

**New:** install from the Chrome Web Store: https://chrome.google.com/webstore/detail/bitford/agjcpjkkccmhfopfciohkkfolnjbbdoh

## Try it

* Go to `chrome://extensions/`
* ☑ Developer mode
* Load unpacked extension...
* Choose this directory
* Launch
* Keep an eye on the console of the background page

## Roadmap

### UI

* Display file saving progress

### Background

* Couple piece receiving to chunk store with background sha1 hashing
* Fix recovery
* store-backend: unify open bitford-store
* Tracker event
* Smarter peer selection
* Priorities & unchoke buckets
* Peer connections should wait for store recovery

### Unsolved

* Intercept .torrent files that users download
  * https://github.com/Rob--W/pdf.js/commit/e181a3c902485a5c3e155c555abb6d686604457b

### Torrent Features

* Peer limits
  * Connect rate
  * by IP
  * Upload slots
* Extension protocol
* Magnet Links
* DHT
* Encryption
* uTP
