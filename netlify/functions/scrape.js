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
        return { statusCode: 200, body: JSON.stringify({ success: true, message: "No classes found.", data: [] }) };
    }

    // NEW: Extract columns and group by day
    const timetableData = await page.evaluate(() => {
        // 1. Get the day names from the top of the calendar (e.g., "28 Monday")
        const headers = Array.from(document.querySelectorAll('thead .mis-calendar-date'));
        const dayNames = headers.map(th => th.innerText.replace(/\n/g, ' ').trim());

        // 2. Get the columns that hold the actual events (skipping the time axis column)
        const dayColumns = Array.from(document.querySelectorAll('tbody tr:first-child > td')).slice(1);

        const schedule = [];

        // 3. Loop through each column (Monday, Tuesday, etc.)
        dayColumns.forEach((col, index) => {
            const dayName = dayNames[index] || `Day ${index + 1}`;
            const events = col.querySelectorAll('.mis-cal-event');
            const classes = [];
            const seen = new Set();

            events.forEach(event => {
                const timeEl = event.querySelector('.mis-cal-event-time');
                const titleEl = event.querySelector('.title');
                
                if (timeEl && titleEl) {
                    const timeString = timeEl.innerText.trim();
                    const rawText = titleEl.innerText.trim();
                    
                    // Filter out 0-minute announcements (e.g., CAFOD)
                    const times = timeString.split('-');
                    if (times.length === 2 && times[0] === times[1]) return;

                    const uniqueId = timeString + rawText;
                    if (!seen.has(uniqueId)) {
                        seen.add(uniqueId);
                        classes.push({ time: timeString, rawText: rawText });
                    }
                }
            });

            // If this specific day has classes, add it to our final schedule
            if (classes.length > 0) {
                classes.sort((a, b) => a.time.localeCompare(b.time));
                schedule.push({ day: dayName, classes: classes });
            }
        });

        return schedule;
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ 
        success: true, 
        message: `Successfully synced the week!`, 
        data: timetableData 
      }),
    };

  } catch (error) {
    return { statusCode: 500, body: JSON.stringify({ success: false, error: error.message }) };
  } finally {
    if (browser !== null) { await browser.close(); }
  }
};