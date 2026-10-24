const puppeteer = require('puppeteer-core');

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: "Method Not Allowed" };
  let browser = null;
  let debugStep = "Initializing Request";
  
  try {
    const { email, password } = JSON.parse(event.body);
    if (!email || !password) return { statusCode: 400, body: JSON.stringify({ success: false, error: "Missing email or password" }) };

    debugStep = "Launching Puppeteer";
    console.log(`[DEBUG] ${debugStep}`);
    const chromium = (await import('@sparticuz/chromium')).default;
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    debugStep = "Opening New Page & Setting Intercepts";
    console.log(`[DEBUG] ${debugStep}`);
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', (req) => {
        if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) req.abort();
        else req.continue();
    });

    debugStep = "Navigating to Login Page";
    console.log(`[DEBUG] ${debugStep}`);
    await page.goto('https://login.arbor.sc/', { waitUntil: 'domcontentloaded' });
    
    debugStep = "Typing Credentials";
    console.log(`[DEBUG] ${debugStep}`);
    await page.type('input[type="text"], input[type="email"], input[name="username"]', email);
    await page.type('input[type="password"]', password);
    
    debugStep = "Submitting Login & Waiting for Navigation";
    console.log(`[DEBUG] ${debugStep}`);
    await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
        page.keyboard.press('Enter')
    ]);

    debugStep = "Checking if Login Failed";
    console.log(`[DEBUG] ${debugStep}`);
    if (page.url().includes('login')) return { statusCode: 401, body: JSON.stringify({ success: false, error: "Invalid email or password." }) };

    debugStep = "Navigating to Calendar View";
    console.log(`[DEBUG] ${debugStep}`);
    await page.goto('https://carmel-college.uk.arbor.education/?/my-mis-ui/calendar/', { waitUntil: 'domcontentloaded' });

    const scrapeCurrentView = async (weekLabelName) => {
        debugStep = `Waiting for Calendar Selectors (${weekLabelName})`;
        console.log(`[DEBUG] ${debugStep}`);
        try { await page.waitForSelector('.mis-cal-event-time', { timeout: 3000 }); } catch (err) { console.log(`[DEBUG] No classes found for ${weekLabelName}`); }
        
        debugStep = `Evaluating DOM Data (${weekLabelName})`;
        console.log(`[DEBUG] ${debugStep}`);
        return await page.evaluate(async () => {
            const pageText = document.body.innerText;
            const weekMatch = pageText.match(/\(Week\s*([A-B])\)/i);
            const weekLabel = weekMatch ? `Week ${weekMatch[1].toUpperCase()}` : "Week A";

            const headers = Array.from(document.querySelectorAll('thead .mis-calendar-date'));
            const dayNames = headers.map(th => th.innerText.replace(/\n/g, ' ').trim());
            const dayColumns = Array.from(document.querySelectorAll('tbody tr:first-child > td')).slice(1);
            
            const schedule = [];
            const uniqueFetches = {}; 

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
                            classes.push({ time: timeString, rawText: rawText, teacher: null, room: null, ajaxLink: ajaxLink });
                            
                            if (ajaxLink && !uniqueFetches[rawText]) {
                                uniqueFetches[rawText] = fetch(ajaxLink).then(res => res.text()).then(html => {
                                    const doc = new DOMParser().parseFromString(html, 'text/html');
                                    const listItems = Array.from(doc.querySelectorAll('li'));
                                    const staffLi = listItems.find(li => li.querySelector('b') && li.querySelector('b').innerText.includes('Staff'));
                                    const teacher = staffLi && staffLi.querySelector('span') ? staffLi.querySelector('span').innerText.trim() : null;
                                    const roomLi = listItems.find(li => li.querySelector('b') && (li.querySelector('b').innerText.includes('Room') || li.querySelector('b').innerText.includes('Location')));
                                    const room = roomLi && roomLi.querySelector('span') ? roomLi.querySelector('span').innerText.trim() : null;
                                    return { teacher, room };
                                }).catch(() => ({ teacher: null, room: null }));
                            }
                        }
                    }
                });
                
                if (classes.length > 0) classes.sort((a, b) => a.time.localeCompare(b.time));
                schedule.push({ day: dayName, weekLabel: weekLabel, isHoliday: classes.length === 0, classes: classes });
            });

            const fetchKeys = Object.keys(uniqueFetches);
            const fetchResults = await Promise.all(Object.values(uniqueFetches));
            const cache = {};
            fetchKeys.forEach((key, i) => cache[key] = fetchResults[i]);

            schedule.forEach(day => {
                day.classes.forEach(cls => {
                    if (cache[cls.rawText]) {
                        cls.teacher = cache[cls.rawText].teacher;
                        cls.room = cache[cls.rawText].room;
                    }
                    delete cls.ajaxLink; 
                });
            });
            return schedule;
        });
    };

    debugStep = "Executing Scrape Current View (Week 1)";
    console.log(`[DEBUG] ${debugStep}`);
    const week1 = await scrapeCurrentView("Week 1");
    
    debugStep = "Looking for Next Week Button";
    console.log(`[DEBUG] ${debugStep}`);
    const nextBtn = await page.$('.mis-calendar-navigation-button-next');
    if (nextBtn) {
        debugStep = "Clicking Next Week Button";
        console.log(`[DEBUG] ${debugStep}`);
        await nextBtn.click();
        
        debugStep = "Waiting for Calendar to update";
        console.log(`[DEBUG] ${debugStep}`);
        await new Promise(resolve => setTimeout(resolve, 800)); 
        
        debugStep = "Executing Scrape Current View (Week 2)";
        console.log(`[DEBUG] ${debugStep}`);
        const week2 = await scrapeCurrentView("Week 2");
        week1.push(...week2);
    }

    debugStep = "Returning successful payload";
    console.log(`[DEBUG] ${debugStep}`);
    return { statusCode: 200, body: JSON.stringify({ success: true, message: `Successfully synced!`, data: week1 }) };
  } catch (error) {
    console.error(`[CRASH LOG] Failed at step: ${debugStep}. Error: ${error.toString()}`);
    return { statusCode: 500, body: JSON.stringify({ success: false, step: debugStep, error: error.message || error.toString() }) };
  } finally {
    if (browser !== null) { await browser.close(); }
  }
};