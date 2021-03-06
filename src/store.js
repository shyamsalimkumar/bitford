var requestFileSystem_ = window.requestFileSystem ||
    window.webkitRequestFileSystem;
var PersistentStorage_ = navigator.PersistentStorage ||
    navigator.webkitPersistentStorage;

function Store(torrent, pieceHashes, pieceLength) {
    this.torrent = torrent;
    this.size = 0;
    var files = torrent.files;
    files.forEach(function(file) {
	this.size += file.size;
    }.bind(this));
    this.pieceLength = pieceLength;

    var infoHashHex = bufferToHex(torrent.infoHash);
    this.backend = new StoreBackend(infoHashHex, this.onExisting.bind(this));

    this.pieces = [];
    /* Build pieces... */
    var filesIdx = 0, fileOffset = 0;
    while(filesIdx < files.length) {
	var pieceOffset = 0;
	var chunks = [];
	/* ...from files */
	while(pieceOffset < pieceLength && filesIdx < files.length) {
	    var length = Math.min(pieceLength - pieceOffset, files[filesIdx].size - fileOffset);
	    chunks.push({ path: files[filesIdx].path,
			  fileOffset: fileOffset,
			  offset: pieceOffset,
			  length: length });
	    pieceOffset += length;
	    fileOffset += length;
	    if (fileOffset >= files[filesIdx].size) {
		filesIdx++;
		fileOffset = 0;
	    }
	}
	this.pieces.push(new StorePiece(this, this.pieces.length, chunks, pieceHashes[this.pieces.length]));
    }
    this.fileEntries = {};

    /* Lower bound for interestingPieces */
    this.interestingPiecesThreshold = 2;
    /* Upper bound for interestingPieces */
    this.piecesReadahead = 2 * this.interestingPiecesThreshold;
    this.interestingPieces = [];

    this.sha1Worker = new SHA1Worker();
}
Store.prototype = {
    /* Called back by StoreBackend() when initializing */
    onExisting: function(offset, data, cb) {
	var pending = 1;
	var done = function() {
	    pending--;
	    if (pending < 1) {
		console.log("existing", offset, "done", pending);
		//this.mayHash();
		if (cb)
		    cb();
	    }
	}.bind(this);

	var length = data.byteLength;
	for(var i = Math.floor(offset / this.pieceLength);
	    i < this.pieces.length && i < (offset + length) / this.pieceLength;
	    i++) {

	    var pieceOffset = i * this.pieceLength;
	    var piece = this.pieces[i];
	    for(var j = 0; j < piece.chunks.length; j++) {
		var chunk = piece.chunks[j];
		if (pieceOffset + chunk.offset >= offset &&
		    pieceOffset + chunk.offset + chunk.length <= offset + length) {

		    chunk.state = 'written';
		}
	    }
	    pending++;
	    piece.canHash(offset - pieceOffset, new BufferList([data]), done);
	}
	done();
    },

    remove: function() {
	if (this.sha1Worker) {
	    this.sha1Worker.terminate();
	    this.sha1Worker = null;
	}
	this.backend.remove();
	// HACKS to stop hashing:
	this.pieces.forEach(function(piece) {
	    piece.sha1pos = true;
	});
    },

    isInterestedIn: function(peer) {
	for(var i = 0; i < this.pieces.length; i++) {
	    var piece = this.pieces[i];
	    if (!piece.valid && peer.has(i))
		return true;
	}
	return false;
    },

    // TODO: could return up to a number chunks (optimization)
    nextToDownload: function(peer, forceOne) {
	this.fillInterestingPieces(peer, forceOne);

	for(var i = 0; i < this.interestingPieces.length; i++) {
	    var piece = this.interestingPieces[i];
	    var chunk =
		peer.has(piece.pieceNumber) &&
		piece.nextToDownload(peer);
	    if (chunk)
		return chunk;
	}

	return null;
    },

    fillInterestingPieces: function(hintPeer, forceOne) {
	/* these are proportional to torrent rate,
	   to have piece stealing in time
	*/
	var readaheadTime = 3000;
	var readaheadBytes = readaheadTime * this.torrent.downRate.getRate() / 1000;
	this.interestingPiecesThreshold = Math.max(2, Math.ceil(readaheadBytes / this.pieceLength));
	this.piecesReadahead = 2 * this.interestingPiecesThreshold;

	if (!forceOne && this.interestingPieces.length >= this.interestingPiecesThreshold)
	    /* Don't even start working unless neccessary */
	    return;

	/* Build rarity map */
	var rarity = {};
	var i, piece;
	for(i = 0; i < this.pieces.length; i++) {
	    piece = this.pieces[i];
	    if (piece.valid || (hintPeer && !hintPeer.has(i)))
		continue;

	    rarity[i] = 0;
	    this.torrent.peers.forEach(function(peer) {
		if (!peer.has(i))
		    rarity[i]++;
	    });
	}
	/* Select by highest rarity first, or randomly */
	var idxs = Object.keys(rarity).sort(function(idx1, idx2) {
	    var r1 = rarity[idx1], r2 = rarity[idx2];
	    if (r1 === r2)
		return Math.random() - 0.5;
	    else
		return r2 - r1;
	});
	for(i = 0; (forceOne || this.interestingPieces.length < this.piecesReadahead) && i < idxs.length; i++) {
	    var idx = idxs[i];
	    piece = this.pieces[idx];
	    var alreadyPresent = this.interestingPieces.some(function(presentPiece) {
		return "" + presentPiece.pieceNumber === idx;
	    });
	    if (!alreadyPresent) {
		this.interestingPieces.push(piece);
		forceOne = false;
	    }
	}
    },

    onPieceMissing: function(idx) {
	this.torrent.onPieceMissing(idx);
    },

    onPieceValid: function(idx) {
	console.log("piece",idx,"valid");
	this.interestingPieces = this.interestingPieces.filter(function(piece) {
	    return piece.pieceNumber !== idx;
	});
	this.torrent.onPieceValid(idx);
    },

    getDonePercent: function() {
	var done = 0;
	for(var i = 0; i < this.pieces.length; i++) {
	    if (this.pieces[i].valid)
		done++;
	}
	return Math.floor(100 * done / this.pieces.length);
    },

    getBytesLeft: function() {
	if (typeof this.bytesLeft === 'number')
	    return this.bytesLeft;

	var result = 0;
	for(var i = 0; i < this.pieces.length; i++) {
	    if (!this.pieces[i].valid) {
		this.pieces[i].chunks.forEach(function(chunk) {
		    if (chunk.state === 'missing' || chunk.state === 'requested')
			result += chunk.length;
		});
	    }
	}
	this.bytesLeft = result;
	return result;
    },

    consumeFile: function(path, offset, cb) {
	var i, j, found = false;
	for(i = 0; !found && i < this.pieces.length; i++) {
	    var piece = this.pieces[i];
	    for(j = 0; !found && j < piece.chunks.length; j++) {
		var chunk = piece.chunks[j];
		found = arrayEq(chunk.path, path) &&
		    chunk.fileOffset <= offset &&
		    chunk.fileOffset + chunk.length > offset;
	    }
	}

	if (found) {
	    piece.addOnValid(function() {
		var chunkOffset = piece.pieceNumber * this.pieceLength + chunk.offset;
		if (chunk.data) {
		    var data = chunk.data;
		    if (chunkOffset < offset)
			data = data.getBufferList(offset - chunkOffset);
		    data.readAsArrayBuffer(cb);
		} else {
		    this.backend.readFrom(chunkOffset, function(data) {
			if (chunkOffset < offset)
			    data = data.slice(offset - chunkOffset);
			cb(data);
		    });
		}
	    }.bind(this));
	    
	    /* Interest for readahead */
	    var readahead = [], piecesReadahead = this.piecesReadahead;
	    for(i = piece.pieceNumber; piecesReadahead > 0 && i < this.pieces.length; i++) {
		if (!this.pieces[i].valid) {
		    piecesReadahead--;
		    readahead.push(i);
		}
	    }
	    this.interestingPieces = readahead.map(function(i) {
		return this.pieces[i];
	    }.bind(this)).concat(this.interestingPieces.filter(function(piece) {
		return readahead.indexOf(piece.pieceNumber) === -1;
	    }));
	} else {
	    console.warn("consumeFile: not found", path, "+", offset);
	    cb();
	}
    },

    write: function(pieceNumber, offset, data, cb) {
	if (pieceNumber < this.pieces.length) {
	    var piece = this.pieces[pieceNumber];
	    if (piece.valid) {
		console.warn("Attempting to write to valid piece", this.pieceNumber);
		return;
	    }

	    piece.write(offset, data, function() {
		piece.continueHashing(cb);
	    });
	    this.bytesLeft = null;
	} else
	    cb();
    }
};

var CHUNK_LENGTH = Math.pow(2, 14);  /* 16 KB */

function StorePiece(store, pieceNumber, chunks, expectedHash) {
    this.store = store;
    this.pieceNumber = pieceNumber;
    this.chunks = [];
    for(var i = 0; i < chunks.length; i++) {
	var chunk = chunks[i];
	while(chunk.length > 0) {
	    var l = Math.min(chunk.length, CHUNK_LENGTH);
	    this.chunks.push({
		path: chunk.path,
		fileOffset: chunk.fileOffset,
		offset: chunk.offset,
		length: l,
		state: 'missing'
	    });
	    chunk.fileOffset += l;
	    chunk.offset += l;
	    chunk.length -= l;
	}
    }

    this.expectedHash = expectedHash;
    this.sha1pos = 0;

    this.onValidCbs = [];
}
StorePiece.prototype = {
    nextToDownload: function(peer) {
	var result, requestedChunks = [];
	for(var i = 0; i < this.chunks.length && (!result || result.length < CHUNK_LENGTH); i++) {
	    var chunk = this.chunks[i];
	    if (result || chunk.state === 'missing') {
		chunk.state = 'requested';
		chunk.peer = peer;
		if (!result)
		    result = {
			piece: this.pieceNumber,
			offset: chunk.offset,
			length: 0
		    };
		result.length += chunk.length;
		requestedChunks.push(chunk);
	    }
	}
	var onPieceMissing = this.store.onPieceMissing.bind(this.store, this.pieceNumber);
	if (result)
	    result.cancel = function() {
		requestedChunks.forEach(function(chunk) {
		    chunk.peer = null;
		    if (chunk.state == 'requested')
			chunk.state = 'missing';
		    onPieceMissing();
		});
	    };
	return result;
    },

    read: function(offset, length, cb) {
	if (length < 1)
	    cb();
	else
	    this.store.backend.read(
		this.pieceNumber * this.store.pieceLength + offset,
		length,
		cb
	    );
    },

    write: function(offset, data, cb) {
	for(var i = 0; i < this.chunks.length; i++) {
	    var chunk = this.chunks[i];
	    // TODO: may need to write to multiple chunks in multi-file torrents
	    if (chunk.offset === offset &&
		chunk.length === data.length &&
		(chunk.state === 'missing' || chunk.state === 'requested')) {
		
		chunk.state = 'received';
		chunk.data = data;
		this.canHash(offset, data, cb);
		return;
	    }
	    else if (chunk.offset > offset)
		break;
	}
	cb();
    },

    canHash: function(offset, data, cb) {
	if (offset > this.sha1pos) {
	    /* To be picked up again when preceding data has been hashed */
	    return cb();
	} else if (offset < this.sha1pos) {
	    data.take(this.sha1pos - offset);
	}
	// console.log("piece", this.store.pieces.indexOf(this), "canHash", offset, this.sha1pos);
	var pendingUpdates = 1;
	function onUpdated() {
	    pendingUpdates--;
	    if (pendingUpdates < 1 && cb)
		cb();
	}
	data.getBuffers().forEach(function(buf) {
	    this.sha1pos += buf.byteLength;
	    this.store.sha1Worker.update(this.pieceNumber, buf, onUpdated);
	    pendingUpdates++;
	    /* buf is neutered here, don't reuse data */
	}.bind(this));
	onUpdated();

	var chunk;
	for(var i = 0; i < this.chunks.length; i++) {
	    chunk = this.chunks[i];
	    if (chunk.offset + chunk.length > this.sha1pos) {
		/* Found a piece that follows */
		break;
	    } else if (chunk.offset + chunk.length <= this.sha1pos) {
		chunk.state = 'valid';
	    }
	}
	if (i >= this.chunks.length) {
	    /* No piece followed, validate hash */
	    this.store.sha1Worker.finalize(this.pieceNumber, function(hash) {
		this.onHashed(hash);
	    }.bind(this));
	}
    },

    continueHashing: function(cb) {
	for(var i = 0;
	    i < this.chunks.length &&
	    (this.chunks[i].state == 'received' || this.chunks[i].state == 'valid') &&
	    this.chunks[i].offset <= this.sha1pos;
	    i++) {

	    var chunk = this.chunks[i];
	    var start = this.sha1pos - chunk.offset;
	    if (start >= 0 && start < chunk.length) {
		var len = chunk.length - start;
		var offset = chunk.offset + start;
		if (chunk.data && chunk.data.length > 0) {
		    this.canHash(offset, chunk.data, function() {
			if (i === this.chunks.length - 1)
			    cb();
			else
			    this.continueHashing(cb);
		    }.bind(this));
		} else {
		    /* This path will only be taken if recovery found
		     * stored data for a not yet valid chunk
		     */
		    this.read(offset, len, function(data) {
			if (data.length > 0) {
			    this.canHash(offset, data, cb);
			} else {
			    console.warn("cannotHash", this.pieceNumber, ":", this.chunks[i]);
			    chunk.state = 'missing';
			    this.store.onPieceMissing(this.pieceNumber);
			    cb();
			}
		    }.bind(this));
		}
		return;
	    } else if (start < 0) {
		console.log("cannot Hash", this.chunks, this.sha1pos);
	    }
	}
	cb();
    },

    onHashed: function(hash) {
	hash = new Uint8Array(hash);
	this.sha1 = null;

	var valid = true;
	for(var i = 0; i < 20; i++)
	    valid = valid && (hash[i] === this.expectedHash[i]);
	this.valid = valid;

	if (!valid) {
	    /* Hash corrupt: invalidate */
	    console.warn("Invalid piece", this.pieceNumber, ":", hash, "<>", this.expectedHash);

	    this.sha1pos = 0;
	    for(i = 0; i < this.chunks.length; i++) {
		if (this.chunks[i].state == 'valid')
		    this.chunks[i].state = 'missing';
	    }
	    this.store.onPieceMissing(this.pieceNumber);
	} else {
	    /* Hash checked: validate */
	    console.log("onValid", this.pieceNumber);
	    this.store.onPieceValid(this.pieceNumber);
	    var onValidCbs = this.onValidCbs;
	    this.onValidCbs = [];
	    onValidCbs.forEach(function(cb) {
		try {
		    cb();
		} catch (e) {
		    console.error("onValidCb", this.pieceNumber, e.stack);
		}
	    }.bind(this));
	
	    /* Drop memory storage just after onValidCbs have been run */
	    this.writeToBackend();
	}
    },

    addOnValid: function(cb) {
	if (this.valid)
	    cb();
	else {
	    console.log("addOnValid", this.valid, this.pieceNumber);
	    this.onValidCbs.push(cb);
	    this.store.onPieceMissing(this.pieceNumber);
	}
    },

    /**
     * Persist when piece has gone valid
     **/
    writeToBackend: function() {
	var storeChunkLength = Math.min(512 * 1024, this.store.pieceLength);
	var i;
	
	/* Find first data */
	for(i = 0; i < this.chunks.length && !this.chunks[i].data; i++) {
	}
	if (i >= this.chunks.length) {
	    /* All done */
	    console.log("Piece", this.pieceNumber, "seems fully persisted");
	    return;
	}
	/* i now points to the first chunk that has data */

	var offset = this.chunks[i].offset;
	var length = this.chunks[i].data.length;
	var chunks = [this.chunks[i]];
	/* Collect succeeding chunks until storeChunkLength */
	for(i++; length < storeChunkLength && i < this.chunks.length; i++) {
	    length += this.chunks[i].data.length;
	    chunks.push(this.chunks[i]);
	}
	/* Concatenate */
	var reader = new FileReader();
	reader.onload = function() {
	    try {
		console.log("Write to", this.pieceNumber, "+", offset, ":", reader.result.byteLength, "/", length, "bytes");
		this.store.backend.write(
		    this.pieceNumber * this.store.pieceLength + offset,
		    reader.result, function() {
			chunks.forEach(function(chunk) {
			    chunk.state = 'written';
			    /* free */
			    delete chunk.data;
			});
			/* loop (because we write only up to storeChunkLength */
			this.writeToBackend();
		    }.bind(this));
	    } catch (e) {
		console.error("writeToBackend", e);
		this.writeToBackend();
	    }
	}.bind(this);
	var buffers = [].concat.apply([], chunks.map(function(chunk) {
	    return chunk.data.getBuffers();
	}));
	// console.log("buffers", length, ":", buffers);
	reader.readAsArrayBuffer(new Blob(buffers));
    }
};

function SHA1Worker() {
    this.worker = new Worker("src/sha1-worker.js");
    this.queue = [];
    this.worker.onmessage = function(ev) {
	var cb = this.queue.shift();
	if (cb)
	    cb(ev.data);
    }.bind(this);
}
SHA1Worker.prototype = {
    update: function(index, data, cb) {
	this.worker.postMessage({
	    update: {
		index: index,
		data: data
	    }
	}, [data]);
	this.queue.push(cb);
    },
    finalize: function(index, cb) {
	this.worker.postMessage({
	    finalize: {
		index: index
	    }
	});
	this.queue.push(function(data) {
	    cb(data.hash);
	});
    },
    terminate: function() {
	this.worker.terminate();
    }
};

function bufferToHex(b) {
    b = new Uint8Array(b);
    function pad(s, len) {
	while(s.length < len)
	    s = "0" + s;
	return s;
    }
    var r = "";
    for(var i = 0; i < b.length; i++)
	r += pad(b[i].toString(16), 2);
    return r;
}
