REST API documentation
======================

# Objects
## Status
*Used for error/success messages*

Returned by all API calls unless otherwise noted.

Status `200 Success` on success, `500 Internal Server Error` on unexpected
error.

```
{
    message: String,
    stack: String // hidden in production
}
```

## Song
```
{
    artist: String,
    title: String,
    album: String,
    albumArt: {
        hq: String, // URL
        lq: String // URL
    },
    duration: Number, // ms
    songID: String,
    score: Number,
    backendName: String,
    format: String
}
```

# API paths
## Playlists
### GET /api/playlist
*Fetch current playlist*

Returns:

*Success: Status 200*
```
{
    playlist: [Song],
    curPlaylistPos: Number,
    curSongPos: Number // ms
}
```

### POST /api/playlist
*Replace current playlist*

POST data:
```
{
    playlistId: String,
    backendName: String
}
```

Returns:

Invalid format: `Status 400 Bad Request`
```
Status
```

### POST /api/playlist/song
*Append songs into playlist*

POST data:
```
[Song]
```

Returns:

Invalid format: `Status 400 Bad Request`
```
Status
```

### POST /api/playlist/song/:at
*Insert songs at specified position into playlist*

Parameters:
```
:at (String) - UUID of song to insert after ('-1' = start of playlist)
```

POST data:
```
[Song]
```

Returns:

Invalid format: `Status 400 Bad Request`
```
Status
```

Song with UUID ':at' not found: `Status 404 Not Found`
```
Status
```

### DELETE /api/playlist/song/:at
*Delete songs at specified position in playlist*

Parameters:
```
:at (String) - UUID of song to delete at ('-1' = start of playlist)
```

Query params:
```
- cnt: Number of songs to delete, default = 1
```

Returns:

Song with UUID ':at' not found: `Status 404 Not Found`

```
Status
```

## Search
### GET /api/search

Query params:
```
- artist: match artist with given string.
- title: match title with given string.
- album: match album with given string.
- any: match any of artist, title, album with given string. Takes precedence
  over previous parameters
```

Returns:
Song list: `Status 200 OK`
```
[Song]
```

## Playback Control

### POST /api/playctl
