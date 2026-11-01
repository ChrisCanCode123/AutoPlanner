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
    await page.type('input[type="text"], input[type="email"], input[name="username"]', email);
    await page.type('input[type="password"]', password);
    
    await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
        page.keyboard.press('Enter')
    ]);

    if (page.url().includes('login')) return { statusCode: 401, body: JSON.stringify({ success: false, error: "Invalid email or password." }) };

    await page.goto('https://carmel-college.uk.arbor.education/?/my-mis-ui/calendar/', { waitUntil: 'domcontentloaded' });

    const scrapeCurrentView = async () => {
        try { await page.waitForSelector('thead .mis-calendar-date', { timeout: 15000 }); } catch (err) {}
        
        return await page.evaluate(async () => {
            const pageText = document.body.innerText;
            const weekMatch = pageText.match(/\(Week\s*([A-B])\)/i);
            const weekLabel = weekMatch ? `Week ${weekMatch[1].toUpperCase()}` : "Week A";

            // Force strict 5-day Mon-Fri slicing to destroy phantom weekend DOM elements
            const headers = Array.from(document.querySelectorAll('thead .mis-calendar-date')).slice(0, 5);
            const dayNames = headers.map(th => th.innerText.replace(/\n/g, ' ').trim());
            const dayColumns = Array.from(document.querySelectorAll('tbody tr:first-child > td')).slice(1, 6);
            
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

    const clickNext = async () => {
        return await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            const nextBtn = buttons.find(b => b.innerText.trim() === '>');
            if (nextBtn) { nextBtn.click(); return true; }
            const backupBtn = document.querySelector('.mis-calendar-navigation-button-next');
            if (backupBtn) { backupBtn.click(); return true; }
            return false;
        });
    };

    let week1 = await scrapeCurrentView();
    
    // HOLIDAY SKIPPER: If the first scraped week has 0 classes, discard it and move forward
    const isWeek1Empty = week1.every(day => day.isHoliday);
    if (isWeek1Empty) {
        await clickNext();
        await new Promise(resolve => setTimeout(resolve, 2000));
        week1 = await scrapeCurrentView();
    }

    const clickedNext = await clickNext();
    if (clickedNext) {
        await new Promise(resolve => setTimeout(resolve, 2000)); 
        let week2 = await scrapeCurrentView();
        
        // STRICT A/B LABEL FIX: Automatically flip the label from Week 1 to guarantee accuracy
        const baseLabel = week1[0].weekLabel;
        const alternateLabel = baseLabel.includes('A') ? 'Week B' : 'Week A';
        week2.forEach(d => d.weekLabel = alternateLabel);
        
        week1.push(...week2);
    }

    return { statusCode: 200, body: JSON.stringify({ success: true, message: `Successfully synced!`, data: week1 }) };
  } catch (error) {
    return { statusCode: 500, body: JSON.stringify({ success: false, error: error.message || error.toString() }) };
  } finally {
    if (browser !== null) { await browser.close(); }
  }
};