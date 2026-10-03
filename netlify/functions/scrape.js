const puppeteer = require('puppeteer-core');

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  let browser = null;
  
  try {
    const { email, password } = JSON.parse(event.body);

    if (!email || !password) {
      return { statusCode: 400, body: JSON.stringify({ success: false, error: "Missing email or password" }) };
    }

    const chromium = (await import('@sparticuz/chromium')).default;

    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();
    
    // 1. Go directly to the Carmel College login page
    await page.goto('https://carmel-college.uk.arbor.education/', { waitUntil: 'domcontentloaded' });
    
    const emailSelector = 'input[type="text"], input[type="email"], input[name="username"]';
    await page.waitForSelector(emailSelector);
    await page.type(emailSelector, email);
    
    const passwordSelector = 'input[type="password"]';
    await page.waitForSelector(passwordSelector);
    await page.type(passwordSelector, password);

    await page.keyboard.press('Enter');
    
    // Wait for the dashboard to load
    await page.waitForNavigation({ waitUntil: 'networkidle2' });

    // 2. Navigate directly to your calendar page
    await page.goto('https://carmel-college.uk.arbor.education/?/my-mis-ui/calendar/', { waitUntil: 'networkidle2' });

    // 3. Wait for the calendar class blocks to appear on the screen
    await page.waitForSelector('.mis-cal-event-time', { timeout: 10000 });

    // 4. Extract the class data instantly
    const timetableData = await page.evaluate(() => {
        // Find every class time element on the page
        const timeBlocks = document.querySelectorAll('.mis-cal-event-time');
        const classes = [];

        timeBlocks.forEach(timeBlock => {
            // Grab the parent container (which usually holds the subject name and room too)
            const parent = timeBlock.parentElement;
            
            classes.push({
                eventId: timeBlock.getAttribute('data-eventid'),
                time: timeBlock.innerText.trim(),
                // Get all the text visible on the calendar block
                rawText: parent ? parent.innerText.trim() : 'No extra data'
            });
        });

        return classes;
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