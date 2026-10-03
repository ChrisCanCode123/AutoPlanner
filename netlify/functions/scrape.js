const puppeteer = require('puppeteer-core');

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: "Method Not Allowed" };

  let browser = null;
  
  try {
    const { email, password } = JSON.parse(event.body);
    if (!email || !password) return { statusCode: 400, body: JSON.stringify({ success: false, error: "Missing email or password" }) };

    const chromium = (await import('@sparticuz/chromium')).default;
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();
    
    await page.setRequestInterception(true);
    page.on('request', (req) => {
        if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) req.abort();
        else req.continue();
    });

    await page.goto('https://login.arbor.sc/', { waitUntil: 'domcontentloaded' });
    
    const emailSelector = 'input[type="text"], input[type="email"], input[name="username"]';
    await page.waitForSelector(emailSelector);
    await page.type(emailSelector, email);
    
    const passwordSelector = 'input[type="password"]';
    await page.waitForSelector(passwordSelector);
    await page.type(passwordSelector, password);

    await page.keyboard.press('Enter');
    
    await page.waitForNavigation({ waitUntil: 'networkidle2' });

    const currentUrl = page.url();
    if (currentUrl.includes('login')) {
       return { statusCode: 401, body: JSON.stringify({ success: false, error: "Invalid email or password." }) };
    }

    await page.goto('https://carmel-college.uk.arbor.education/?/my-mis-ui/calendar/', { waitUntil: 'networkidle2' });

    try {
        await page.waitForSelector('.mis-cal-event-time', { timeout: 8000 });
    } catch (err) {
        return { statusCode: 200, body: JSON.stringify({ success: true, message: "No classes found on the calendar today.", data: [] }) };
    }

    const timetableData = await page.evaluate(() => {
        const events = document.querySelectorAll('.mis-cal-event');
        const classes = [];
        const seen = new Set(); // Prevent duplicates

        events.forEach(event => {
            const timeEl = event.querySelector('.mis-cal-event-time');
            const titleEl = event.querySelector('.title');
            
            if (timeEl && titleEl) {
                const timeString = timeEl.innerText.trim();
                const rawText = titleEl.innerText.trim();
                
                // FILTER: Split "14:02-14:02" into two halves. If they match, skip it.
                const times = timeString.split('-');
                if (times.length === 2 && times[0] === times[1]) {
                    return; 
                }

                // Create a unique ID to prevent double-counting the same class
                const uniqueId = timeString + rawText;
                if (!seen.has(uniqueId)) {
                    seen.add(uniqueId);
                    classes.push({
                        time: timeString,
                        rawText: rawText
                    });
                }
            }
        });

        // Sort chronologically
        return classes.sort((a, b) => a.time.localeCompare(b.time));
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ 
        success: true, 
        message: `Successfully synced ${timetableData.length} classes!`, 
        data: timetableData 
      }),
    };

  } catch (error) {
    return { statusCode: 500, body: JSON.stringify({ success: false, error: error.message }) };
  } finally {
    if (browser !== null) { await browser.close(); }
  }
};