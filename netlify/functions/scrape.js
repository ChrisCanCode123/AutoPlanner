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

    const timetableData = await page.evaluate(async () => {
        const headers = Array.from(document.querySelectorAll('thead .mis-calendar-date'));
        const dayNames = headers.map(th => th.innerText.replace(/\n/g, ' ').trim());
        const dayColumns = Array.from(document.querySelectorAll('tbody tr:first-child > td')).slice(1);

        const schedule = [];
        const fetchPromises = []; // Array to hold our concurrent background requests

        dayColumns.forEach((col, index) => {
            const dayName = dayNames[index] || `Day ${index + 1}`;
            const events = col.querySelectorAll('.mis-cal-event');
            const classes = [];
            const seen = new Set();

            events.forEach(event => {
                const timeEl = event.querySelector('.mis-cal-event-time');
                const titleEl = event.querySelector('.title');
                const ajaxLink = event.getAttribute('ajax-link');
                
                if (timeEl && titleEl) {
                    const timeString = timeEl.innerText.trim();
                    const rawText = titleEl.innerText.trim();
                    
                    const times = timeString.split('-');
                    if (times.length === 2 && times[0] === times[1]) return;

                    const uniqueId = timeString + rawText;
                    if (!seen.has(uniqueId)) {
                        seen.add(uniqueId);
                        
                        const classData = { 
                            time: timeString, 
                            rawText: rawText,
                            teacher: null,
                            room: null
                        };
                        classes.push(classData);

                        // If Arbor attached a hidden tooltip link, prepare to fetch it
                        if (ajaxLink) {
                            const promise = fetch(ajaxLink)
                                .then(res => res.text())
                                .then(html => {
                                    // Parse the downloaded tooltip HTML
                                    const parser = new DOMParser();
                                    const doc = parser.parseFromString(html, 'text/html');
                                    const listItems = Array.from(doc.querySelectorAll('li'));
                                    
                                    // Hunt for the "Staff" element you found in the inspector
                                    const staffLi = listItems.find(li => li.querySelector('b') && li.querySelector('b').innerText.includes('Staff'));
                                    if (staffLi && staffLi.querySelector('span')) {
                                        classData.teacher = staffLi.querySelector('span').innerText.trim();
                                    }
                                    
                                    // Hunt for the Room/Location element
                                    const roomLi = listItems.find(li => li.querySelector('b') && (li.querySelector('b').innerText.includes('Room') || li.querySelector('b').innerText.includes('Location')));
                                    if (roomLi && roomLi.querySelector('span')) {
                                        classData.room = roomLi.querySelector('span').innerText.trim();
                                    }
                                })
                                .catch(e => console.error("Tooltip fetch failed", e));
                            
                            fetchPromises.push(promise);
                        }
                    }
                }
            });

            if (classes.length > 0) {
                classes.sort((a, b) => a.time.localeCompare(b.time));
                schedule.push({ day: dayName, classes: classes });
            }
        });

        // WAIT for all 20+ tooltip downloads to finish simultaneously before continuing
        await Promise.all(fetchPromises);

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