function main() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheets()[0];
  const range = sheet.getRange('B2:B');
  const values = range.getValues();

  for (let i = 0; i < values.length; i++) {
    if (values[i] == '') {
      continue;
    }

    const cellFeedName = sheet.getRange('A' + (i + 2));
    const cellPollDate = sheet.getRange('C' + (i + 2));
    const cellSkip = sheet.getRange('D' + (i + 2));
    const cellWebhookURL = sheet.getRange('E' + (i + 2));

    if (cellSkip.getValue()) {
      continue;
    }

    try {
      const pollDate = cellPollDate.getValue();
      cellPollDate.setValue(new Date().toISOString());

      const feed = readRSS(values[i], pollDate);
      feed.forEach((data) => {
        Logger.log(data);
        response = postHook(cellWebhookURL.getValue(), cellFeedName.getValue(), data);
        console.log(response.getResponseCode());
        console.log(response.getContentText());
      });
    } catch (e) {
      Logger.log(e);
      continue;
    }
  }
}

function readRSS(url, pollDate)
{
  // https://developers.google.com/apps-script/reference/xml-service/xml-service
  const response = UrlFetchApp.fetch(url);
  const document = XmlService.parse(response.getContentText());
  const root = document.getRootElement();
  const contents = [];

  let namespace = null;
  let pubElement = null;
  let channel = null;
  let entries = [];

  switch (root.getName().toLowerCase()) {
    case "feed":
      namespace = XmlService.getNamespace("http://www.w3.org/2005/Atom");
      pubElement = "published"
      entries = root.getChildren("entry", namespace);
      break;
    case "rdf":
      namespace = XmlService.getNamespace("http://purl.org/rss/1.0/");
      pubElement = "pubDate";
      entries = root.getChildren("item", namespace);
      break;
    case "rss":
      namespace = XmlService.getNoNamespace();
      pubElement = "pubDate";
      channel = root.getChild("channel");
      entries = channel.getChildren("item", namespace);
      break;
    default:
      Logger.log(`Type {root.getName().toLowerCase()} not supported!`);
      return contents;
  }

  entries.forEach((entry) => {
    const title = entry.getChild("title", namespace).getText();
    const link = entry.getChild("link", namespace).getAttribute("href")?.getValue()
      ?? entry.getChild("link", namespace).getText();
    const published = entry.getChild(pubElement, namespace).getText();

    if (Date.parse(pollDate) >= Date.parse(published)) {
      return;
    }

    contents.push([title, link, published]);
  });

  return contents;
}

function postHook(webhookURL, feedName, data)
{
  // https://discord.com/developers/docs/resources/webhook#execute-webhook
  const params = {
    method: "POST",
    contentType: "application/json",
    muteHttpExceptions: false,
    payload: JSON.stringify({
      username: feedName,
      // avatar_url: "https://rss.com/blog/wp-content/uploads/2019/10/social_style_3_rss-512-1.png",
      embeds: [
        {
          type: "rich",
          title: data[0],
          url: data[1],
          timestamp: new Date(data[2]).toISOString(),
        },
      ],
    }),
  };

  return UrlFetchApp.fetch(`${webhookURL}?wait=1`, params);
}
