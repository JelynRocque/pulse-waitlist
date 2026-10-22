# Waitlist Apps Script

The waitlist and survey post to a Google Apps Script bound to the "Pulse Waitlist" Google Sheet
(Extensions > Apps Script). `shade_update.gs` is the "update your shade" addition, appended to the
end of that script. `doPost` routes to it with:

```js
if (data.form === "shade_link") return sendShadeLink_(data);
if (data.form === "shade_update") return saveShade_(data);
```

After changing the script: Deploy > Manage deployments > pencil icon > Version: New version > Deploy.
(Not "New deployment": that changes the web address the site posts to.)
