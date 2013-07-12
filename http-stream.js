createHTTPServer(8080, function(req, res) {
    var path = req.path.split("/");
    while(path[0] === "")
	path.shift();

    var contentType = getMimeType(path);
    var size;
    for(var i = 0; i < torrents.length; i++) {
	var torrent = torrents[i];
	for(var j = 0; j < torrent.files.length; j++) {
	    if (arrayEq(torrent.files[j].path, path)) {
		size = torrent.files[j].size;
		break;
	    }
	}
	if (j < torrent.files.length)
	    break;
    }
    if (i < torrents.length) {
	var m, start, end;
	if ((m = (req.headers["Range"] + "").match(/^bytes=(\d*)-(\d*)/))) {
	    start = parseInt(m[1], 10);
	    end = parseInt(m[2], 10);
	    if (end)
		end++;
	    else
		end = size;
	}
	console.log("start", start, "end", end);
	if (typeof start !== 'number')
	    res.writeHead(200, "OK", {
		"Content-Type": contentType,
		"Content-Length": size + ""
	    });
	else
	    res.writeHead(206, "Partial content", {
		"Content-Type": contentType,
		"Content-Range": "bytes " + (typeof start == 'number' ? start : "") + "-" + (end ? (end - 1) : "") + "/" + size,
		"Content-Length": (end - start) + ""
	    });

	var bytes = start || 0;
	var looping = false;
	function loop() {
	    if (looping)
		return;
	    looping = true;
	    console.log("loop", bytes, "/", end, size);
	    if (bytes >= size || bytes >= end) {
		res.end();
		return;
	    }

	    torrent.store.consumeFile(path, bytes, function(data) {
		console.log("consumed", path, bytes, data.byteLength);
		if (data.byteLength > 0) {
		    res.write(data);
		    bytes += data.byteLength;
		    looping = false;
		} else
		    res.end();
	    });
	}
	res.onDrain = loop;
	loop();
    } else {
	res.writeHead(404, "Not found", {});
	res.end();
    }
});
