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
    await page.keyboard.press('Enter');
    await page.waitForNavigation({ waitUntil: 'networkidle2' });

    if (page.url().includes('login')) return { statusCode: 401, body: JSON.stringify({ success: false, error: "Invalid email or password." }) };

    await page.goto('https://carmel-college.uk.arbor.education/?/my-mis-ui/calendar/', { waitUntil: 'networkidle2' });

    const scrapeCurrentView = async () => {
        try { await page.waitForSelector('.mis-cal-event-time', { timeout: 5000 }); } catch (err) { /* Ignore timeout for empty holiday weeks */ }
        return await page.evaluate(async () => {
            const pageText = document.body.innerText;
            const weekMatch = pageText.match(/\(Week\s*([A-B])\)/i);
            const weekLabel = weekMatch ? `Week ${weekMatch[1].toUpperCase()}` : "Week A";

            const headers = Array.from(document.querySelectorAll('thead .mis-calendar-date'));
            const dayNames = headers.map(th => th.innerText.replace(/\n/g, ' ').trim());
            const dayColumns = Array.from(document.querySelectorAll('tbody tr:first-child > td')).slice(1);
            const schedule = [];
            const fetchPromises = [];

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
                            const classData = { time: timeString, rawText: rawText, teacher: null, room: null };
                            classes.push(classData);

                            if (ajaxLink) {
                                fetchPromises.push(fetch(ajaxLink).then(res => res.text()).then(html => {
                                    const doc = new DOMParser().parseFromString(html, 'text/html');
                                    const listItems = Array.from(doc.querySelectorAll('li'));
                                    const staffLi = listItems.find(li => li.querySelector('b') && li.querySelector('b').innerText.includes('Staff'));
                                    if (staffLi && staffLi.querySelector('span')) classData.teacher = staffLi.querySelector('span').innerText.trim();
                                    const roomLi = listItems.find(li => li.querySelector('b') && (li.querySelector('b').innerText.includes('Room') || li.querySelector('b').innerText.includes('Location')));
                                    if (roomLi && roomLi.querySelector('span')) classData.room = roomLi.querySelector('span').innerText.trim();
                                }).catch(e => console.error(e)));
                            }
                        }
                    }
                });
                
                if (classes.length > 0) classes.sort((a, b) => a.time.localeCompare(b.time));
                
                // CRITICAL FIX: Push the day to the array even if there are zero classes (Holiday)
                schedule.push({ 
                    day: dayName, 
                    weekLabel: weekLabel, 
                    isHoliday: classes.length === 0,
                    classes: classes 
                });
            });
            await Promise.all(fetchPromises);
            return schedule;
        });
    };

    const week1 = await scrapeCurrentView();
    
    const nextBtn = await page.$('.mis-calendar-navigation-button-next');
    if (nextBtn) {
        await nextBtn.click();
        await page.waitForTimeout(2000); 
        const week2 = await scrapeCurrentView();
        week1.push(...week2);
    }

    return { statusCode: 200, body: JSON.stringify({ success: true, message: `Successfully synced!`, data: week1 }) };
  } catch (error) {
    return { statusCode: 500, body: JSON.stringify({ success: false, error: error.message }) };
  } finally {
    if (browser !== null) { await browser.close(); }
  }
};