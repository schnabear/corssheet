function main() {
  const MAX_FEED_HOURS_TTL = 24;
  const MAX_CACHE_SECS_TTL = 60 * 60;

  const COLUMN_NAME = 0;
  const COLUMN_FEED_URL = 1;
  const COLUMN_WEBHOOK_URL = 2;
  const COLUMN_CONTENT = 3
  const COLUMN_SKIP_FLAG = 4;
  const COLUMN_POLL_TIME = 5;

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheets()[0];
  const range = sheet.getDataRange().offset(1, 0); // sheet.getRange('A2:A')
  const values = range.getValues();

  const nowLessSpan = new Date();
  nowLessSpan.setHours(nowLessSpan.getHours() - MAX_FEED_HOURS_TTL);

  values.forEach((value, i) => {
    if (value[COLUMN_FEED_URL] == '' || value[COLUMN_SKIP_FLAG]) {
      return;
    }

    try {
      range.getCell(i + 1, COLUMN_POLL_TIME + 1).setValue(new Date().toISOString());

      const cache = JSON.parse(CacheService.getScriptCache().get(md5(value[COLUMN_FEED_URL]))) ?? {};
      const entries = {};

      const feed = readRSS(value[COLUMN_FEED_URL]);
      feed.forEach((data) => {
        if (new Date(data.created) < nowLessSpan) {
          return;
        }

        const entryID = md5(data.link);
        entries[entryID] = {
          ...data,
          messageID: cache[entryID]?.messageID ?? null,
        };

        Logger.log(data);
      });

      Object.entries(entries).forEach(([k, v]) => {
        if (k in cache) {
          return;
        }

        Logger.log(`++ ${v.link}`);
        response = postHook(value[COLUMN_WEBHOOK_URL], value[COLUMN_NAME], value[COLUMN_CONTENT], v);
        entries[k].messageID = JSON.parse(response.getContentText())?.id ?? null;
      });
      Object.entries(cache).forEach(([k, v]) => {
        if (new Date(cache[k].created) < nowLessSpan || k in entries) {
          return;
        }

        Logger.log(`-- ${v.link}`);
        try {
          response = deleteHook(value[COLUMN_WEBHOOK_URL], v);
          Logger.log(response.getResponseCode());
        } catch (e) {
          // {"message": "Unknown Message", "code": 10008} (use muteHttpExceptions option to examine full response)
          Logger.log(e);
        }
      });

      Logger.log(cache);
      Logger.log(entries);
      CacheService.getScriptCache().put(md5(value[COLUMN_FEED_URL]), JSON.stringify(entries), MAX_CACHE_SECS_TTL);
    } catch (e) {
      Logger.log(e);
    }
  });
}

function md5(string) {
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, String(string)));
}

function readRSS(url) {
  const response = UrlFetchApp.fetch(url);
  const contentType = response.getHeaders()["Content-Type"];
  const contentText = response.getContentText();

  if (contentType.includes("application/json") || contentText.trim().startsWith("{")) {
    return parseJSON(contentText);
  } else {
    return parseXML(contentText);
  }
}

function parseJSON(contentText) {
  const feed = JSON.parse(contentText) ?? {};
  return (feed?.items || []).map((item) => ({
    name: feed.title,
    title: item.title,
    link: item.url,
    created: item.date_published,
  }));
}

function parseXML(contentText) {
  // https://developers.google.com/apps-script/reference/xml-service/xml-service
  const document = XmlService.parse(contentText);
  const root = document.getRootElement();

  let namespace = null;
  let pubElement = null;
  let channel = null;
  let name = "";
  let entries = [];

  switch (root.getName().toLowerCase()) {
    case "feed":
      namespace = XmlService.getNamespace("http://www.w3.org/2005/Atom");
      pubElement = "published";
      name = root.getChild("title", namespace).getText();
      entries = root.getChildren("entry", namespace);
      break;
    case "rdf":
      namespace = XmlService.getNamespace("http://purl.org/rss/1.0/");
      pubElement = "pubDate";
      channel = root.getChild("channel", namespace);
      name = channel.getChild("title", namespace).getText();
      entries = root.getChildren("item", namespace);
      break;
    case "rss":
      namespace = XmlService.getNoNamespace();
      pubElement = "pubDate";
      channel = root.getChild("channel",namespace);
      name = channel.getChild("title", namespace).getText();
      entries = channel.getChildren("item", namespace);
      break;
    default:
      Logger.log(`Type ${root.getName().toLowerCase()} not supported!`);
      return [];
  }

  Logger.log(name);
  return (entries || []).map((entry) => {
    // https://github.com/synzen/MonitoRSS/blob/main/services/backend-api/src/services/feed-fetcher/utils/Article.js#L261
    const title = entry.getChild("title", namespace)?.getText()
      || "UNTITLED";
    const link = entry.getChild("link", namespace).getAttribute("href")?.getValue()
      || entry.getChild("link", namespace)?.getText();
    const published = entry.getChild(pubElement, namespace)?.getText()
      || entry.getChild("updated", namespace)?.getText();

    if (!link || !published) {
      // TODO : Handling of entries without link, published and updated dates
      return null;
    }

    return {
      name: name,
      title: title,
      link: link,
      created: published,
    };
  }).filter((entry) => {
    return entry;
  });
}

function postHook(webhookURL, customName, extraContent, data) {
  eval(UrlFetchApp.fetch('https://cdnjs.cloudflare.com/ajax/libs/URI.js/1.19.11/URI.min.js').getContentText());
  const title = data.title.length > 256 ? `${data.title.substring(0, 250)}...` : data.title;

  // https://discord.com/developers/docs/resources/webhook#execute-webhook
  const params = {
    method: "POST",
    contentType: "application/json",
    muteHttpExceptions: false,
    payload: JSON.stringify({
      username: customName || data.name,
      embeds: [
        {
          title: title,
          url: data.link,
          timestamp: new Date(data.created).toISOString(),
          footer: {
            text: URI(data.link).hostname(),
          },
        },
      ],
      allowed_mentions: {
        parse: ["users", "roles", "everyone"]
      },
      content: extraContent.replace("{title}", title),
    }),
  };

  Utilities.sleep(1000);
  return UrlFetchApp.fetch(`${webhookURL}?wait=1`, params);
}

function deleteHook(webhookURL, data) {
  // https://discord.com/developers/docs/resources/webhook#delete-webhook-message
  const params = {
    method: "DELETE",
    contentType: "application/json",
    muteHttpExceptions: false,
  };

  Utilities.sleep(1000);
  return UrlFetchApp.fetch(`${webhookURL}/messages/${data.messageID}`, params);
}
