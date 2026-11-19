#!/usr/bin/env python3
"""Build the client guide: python -m pip install reportlab==4.4.9; python scripts/generate-system-guide.py."""
from pathlib import Path
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak, KeepTogether
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_LEFT
from reportlab.graphics.shapes import Drawing, Rect, String, Line, Polygon
from reportlab.lib.utils import simpleSplit

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'docs/RMS-System-Guide.pdf'
NAVY = colors.HexColor('#132E3A')
TEAL = colors.HexColor('#087F80')
PALE = colors.HexColor('#EDF6F5')
GRAY = colors.HexColor('#52636C')
AMBER = colors.HexColor('#FFF3DD')
styles = getSampleStyleSheet()
styles.add(ParagraphStyle(name='TitleRMS', fontName='Helvetica-Bold', fontSize=30, leading=35, textColor=NAVY, spaceAfter=17))
styles.add(ParagraphStyle(name='SubtitleRMS', fontSize=13, leading=19, textColor=GRAY, spaceAfter=18))
styles.add(ParagraphStyle(name='SectionRMS', fontName='Helvetica-Bold', fontSize=20, leading=25, textColor=NAVY, spaceAfter=15))
styles.add(ParagraphStyle(name='SmallRMS', fontSize=9, leading=13, textColor=GRAY, spaceAfter=8))
styles['BodyText'].fontSize = 10
styles['BodyText'].leading = 15
styles['BodyText'].spaceAfter = 9
styles['BodyText'].textColor = NAVY
styles['Heading2'].textColor = TEAL
styles['Heading2'].spaceBefore = 12
styles['Heading2'].spaceAfter = 9
styles.add(ParagraphStyle(name='CellRMS', fontSize=9, leading=12.5, textColor=NAVY))
styles.add(ParagraphStyle(name='HeadCellRMS', fontSize=9, leading=12, textColor=colors.white, fontName='Helvetica-Bold'))
story = []
def p(text, style='BodyText'):
    return Paragraph(text, styles[style])
def add(text, style='BodyText'):
    story.append(p(text, style))
def heading(kicker, title):
    add(kicker.upper(), 'SmallRMS'); add(title, 'SectionRMS')
def section(title): add(title, 'Heading2')
def bullet(text): add('• ' + text)
def notice(text):
    t = Table([[p(text, 'SmallRMS')]], colWidths=[495]); t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,-1),AMBER),('BOX',(0,0),(-1,-1),0.5,colors.HexColor('#EAC987')),('LEFTPADDING',(0,0),(-1,-1),12),('RIGHTPADDING',(0,0),(-1,-1),12),('TOPPADDING',(0,0),(-1,-1),10),('BOTTOMPADDING',(0,0),(-1,-1),5)])); story.extend([t, Spacer(1,12)])
def table(rows, widths=(155,340), headers=('Feature / workspace','What it does')):
    data = [[p(x,'HeadCellRMS') for x in headers]] + [[p(x,'CellRMS') for x in r] for r in rows]
    t = Table(data,colWidths=widths,repeatRows=1,hAlign='LEFT')
    t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,0),NAVY),('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.white,PALE]),('VALIGN',(0,0),(-1,-1),'TOP'),('LEFTPADDING',(0,0),(-1,-1),10),('RIGHTPADDING',(0,0),(-1,-1),10),('TOPPADDING',(0,0),(-1,-1),9),('BOTTOMPADDING',(0,0),(-1,-1),9),('LINEBELOW',(0,0),(-1,0),1,TEAL)]))
    story.extend([t,Spacer(1,12)])
def flow(steps):
    """Vector snake flow; two or three rows, read numbered cards left-to-right then back."""
    rows = (len(steps)+2)//3
    d = Drawing(495, rows*116)
    positions=[]
    for i,(title,body) in enumerate(steps):
        row,col=divmod(i,3)
        if row%2: col=2-col
        x=col*172; y=(rows-1-row)*116+22
        positions.append((x,y))
        d.add(Rect(x,y,150,84,rx=8,ry=8,fillColor=PALE,strokeColor=TEAL,strokeWidth=0.7))
        d.add(String(x+10,y+66,f'{i+1:02d}  {title}',fontName='Helvetica-Bold',fontSize=9.2,fillColor=NAVY))
        lines = simpleSplit(body,'Helvetica',8.8,130)
        assert len(lines) <= 4, f'Diagram text overflow: {title}'
        for j,line in enumerate(lines):
            d.add(String(x+10,y+49-j*11,fontName='Helvetica',fontSize=8.8,text=line,fillColor=GRAY))
    for i in range(len(positions)-1):
        x,y=positions[i]; nx,ny=positions[i+1]
        if y==ny:
            right=nx>x; a=x+150 if right else x; b=nx if right else nx+150; yy=y+42
            d.add(Line(a,yy,b,yy,strokeColor=TEAL,strokeWidth=1.5))
            sign=1 if right else -1
            d.add(Polygon([b,yy,b-sign*6,yy+3,b-sign*6,yy-3],fillColor=TEAL,strokeColor=TEAL))
        else:
            xx=x+75; a=y; b=ny+84
            d.add(Line(xx,a,xx,b,strokeColor=TEAL,strokeWidth=1.5))
            d.add(Polygon([xx,b,xx-3,b+6,xx+3,b+6],fillColor=TEAL,strokeColor=TEAL))
    story.extend([d,Spacer(1,10)])
def page(): story.append(PageBreak())

add('RMS  /  CLIENT OPERATIONS GUIDE', 'SmallRMS')
add('One system.<br/>Every restaurant workflow.', 'TitleRMS')
add('How RMS works, what each feature does, and how staff move from setup to service and daily reporting.', 'SubtitleRMS')
notice('<b>Scope:</b> Guide to the current branch, reviewed 19 November 2026. Core operational screens are implemented; payment, messaging and vendor integrations have the limitations listed on page 8. This is not a production certification.')
section('Who uses the system?')
table([
('<b>Platform owner</b>', 'Creates restaurants, manages plans and platform operators, suspends access and resets restaurant administrator PINs.'),
('<b>Restaurant manager</b>', 'Configures the store, menu, tables, inventory and staff; manages labour, exceptions and reports.'),
('<b>Service team</b>', 'Hosts seat guests; servers enter orders; kitchen and expo prepare and coordinate food; cashiers record checkout.'),
('<b>Guest</b>', 'Scans a table QR code, orders, follows progress, requests help and accesses engagement features.')
])
section('How the pieces connect')
flow([('Platform console','Creates a separate workspace for each restaurant.'),('Restaurant workspace','Staff use screens allowed by their role and plan.'),('Store database','Each restaurant keeps its own operational SQLite data.')])
add('Read this guide in order: feature map (2–3), service flow (4), guest flow (5), back-office flow (6), setup and daily routine (7), limitations (8).', 'SmallRMS')
page()

heading('Feature map / front of house', 'Service and customer screens')
table([
('<b>Staff sign-in</b><br/>/login','Restaurant code + PIN selects the correct store. Optional clock-in begins attendance. Roles and plan entitlements determine access.'),
('<b>Host desk</b><br/>/host','Manages reservations and the waitlist, tracks parties and supports seating into available tables.'),
('<b>Live floor</b><br/>/floor','Shows table/service status and active tickets so staff can coordinate seating, attention and table turnover.'),
('<b>Point of sale</b><br/>/pos','Creates and edits tickets, quantities, modifiers and courses; sends or fires items to the kitchen. Restricted actions require permission.'),
('<b>Checkout</b><br/>/checkout/[orderId]','Calculates the bill, supports split previews, tenders, tips and receipts. Staff record money collected externally; RMS is not a card processor.'),
('<b>Kitchen display</b><br/>/kds/[station]','Station-specific queues show routed items, elapsed times and preparation status. Staff mark food ready as work completes.'),
('<b>Expo board</b><br/>/expo','Coordinates ready items across stations at the pass and helps the service team track ticket completion.'),
('<b>Prep sheets</b><br/>/prep','Provides kitchen preparation views to plan and organize prep work.'),
('<b>Customer display</b><br/>/cfd','Read-only terminal display for the customer-facing ticket and payment QR. Showing a QR does not verify payment.'),
('<b>Guest ordering</b><br/>/t/[token]','Table-linked digital menu and ordering, live progress, waiter requests, reviews, loyalty and quiz features. Staff collect production payments.')
])
add('<b>Role examples are operational descriptions, not guarantees of access.</b> Actual screen/API permissions depend on the restaurant role matrix and subscribed plan.', 'SmallRMS')
page()

heading('Feature map / management', 'Configuration, stock, people and reports')
table([
('<b>Menu & modifiers</b><br/>/admin/menu','Creates categories, menu items, prices, required/optional modifier choices and availability. Configures preparation routing.'),
('<b>Floor plan builder</b><br/>/admin/floorplan','Maintains sections, table capacity, shape and layout used by the live floor.'),
('<b>Users & permissions</b><br/>/admin/users','Manages employees, PINs, active status and role permissions, within plan seat limits.'),
('<b>QR codes</b><br/>/admin/qrcodes','Creates and manages table-linked guest entry tokens, QR stickers, activation and rotation.'),
('<b>Store settings</b><br/>/admin/settings','Store identity, timezone, taxes, service charge, tips, workflow presets, security, hardware and integration configuration.'),
('<b>Inventory</b><br/>/admin/inventory','Tracks ingredient stock, costs, reorder information and stock movements.'),
('<b>Recipe costing</b><br/>/admin/recipes','Connects menu items to ingredient quantities; supports costing and recipe-based stock deduction at checkout.'),
('<b>Vendors & orders</b><br/>/admin/vendors','Manages suppliers and purchase-order drafts, approvals and documents. Automated delivery is blocked until real transport exists.'),
('<b>Waste & counts</b><br/>/admin/waste','Records ingredient waste and stock counts so physical stock can be reconciled with the system.'),
('<b>Shift scheduler</b><br/>/admin/schedule','Adds/deletes shifts, navigates weeks, copies a prior week, publishes schedules and decides swap requests.'),
('<b>Time Clock</b><br/>/admin/timeclock','Shows attendance and manager punches, reason-required corrections and overtime approval.'),
('<b>Analytics</b><br/>/admin/executive<br/>/admin/pmix<br/>/admin/zreport','Executive performance overview; product sales mix; business-day/drawer reconciliation and day-close reporting.')
])
page()

heading('Workflow 01 / daily service', 'From guest arrival to a closed check')
add('Numbered cards show the normal staff-led sequence. Read across the top row, then follow the arrows back across the next row.')
flow([
('Seat the party','Host checks reservations or waitlist, then seats an available table.'),
('Open the ticket','Server opens the table ticket, records guests and adds menu items.'),
('Choose & send','Apply required modifiers and send or fire the selected course.'),
('Prepare food','Kitchen stations work their queues and mark items ready.'),
('Coordinate service','Expo and floor staff coordinate readiness and delivery to guests.'),
('Review the bill','Cashier reviews taxes, service charge, tips and any permitted adjustments.'),
('Collect payment','Collect cash or verify payment using an external terminal/provider.'),
('Close the check','Record the tender and close; receipt and recipe stock deduction follow.'),
('Turn over & report','Reset the table as needed; sales and stock records feed reporting.')
])
section('Important controls')
bullet('Menu prices and modifiers are snapshotted onto ticket lines, preserving the sale even if the menu changes later.')
bullet('Voids, discounts, checkout and management actions are permission-controlled. Kitchen readiness checks may require an authorized override for early closure.')
bullet('Stock deduction depends on configured recipes. Correct opening stock and ingredient mappings are essential for useful stock figures.')
notice('<b>Payment boundary:</b> recording a card/wallet tender is an accounting action. It does not prove settlement. Staff must verify real payment before recording and closing the bill.')
page()

heading('Workflow 02 / QR self-service', 'What happens when a guest scans a table')
flow([
('Scan the QR','A token identifies the restaurant/table. Invalid tokens must be replaced by staff.'),
('Join & browse','Guest joins the table session and browses available menu items.'),
('Build an order','Guest selects quantities and required modifiers, then submits.'),
('Staff approval','Submitted QR orders enter the staff approval workflow before kitchen handling.'),
('Kitchen progress','Preparation status and estimated progress are visible to the guest.'),
('Staff payment','Guest settles with staff; self-verified online payment is blocked in production.')
])
section('Guest features explained')
table([
('<b>Need something?</b>', 'Guest service requests help the floor team respond without waiting for a server to walk past.'),
('<b>Live status</b>', 'The guest follows ticket progress. Preparation estimates are guidance, not a guaranteed delivery time.'),
('<b>Loyalty & review</b>', 'Guest identity/loyalty linking, reward redemption and order reviews are available in the guest workflow, subject to its rules.'),
('<b>Wait engagement</b>', 'Quiz and engagement features provide optional activity while the table waits.'),
('<b>Receipt email</b>', 'The system can queue a receipt email record. Delivery is not implemented; queued does not mean delivered.')
])
notice('<b>QR safety:</b> treat table tokens as access links. Rotate exposed or misplaced QR codes and use the QR management screen to disable obsolete tokens.')
page()

heading('Workflow 03 / back office', 'Keeping stock and labour aligned')
section('Inventory and purchasing')
flow([
('Set ingredients','Enter real items, units, costs, opening stock and reorder levels.'),
('Map recipes','Link each menu item to the ingredient quantities it consumes.'),
('Use & reconcile','Closed sales deduct recipe stock; record waste and count variances.'),
('Plan replenishment','Review low stock, suggested orders and vendor requirements.'),
('Approve the PO','Manager reviews quantities and costs; export the order document.'),
('Deliver & receive','Transport is not implemented. Receiving requires a valid sent PO; complete dispatch integration first.')
])
notice('<b>Current gap:</b> automatic vendor email/SFTP and retry actions are disabled outside demo mode. Exporting a document does not mark a purchase order as sent. The full production dispatch-to-receiving loop needs real transport or an audited manual-dispatch feature.')
section('Scheduling and attendance')
flow([
('Plan the week','Add shifts, copy the previous week and review pending swaps.'),
('Publish shifts','Publish the weekly plan so scheduled coverage is recorded.'),
('Track actual work','Clock in/out, approve overtime and correct punches with a reason.')
])
add('Managers compare actual labour and sales using reporting. Staff can punch only themselves unless they have time-clock management permission.', 'SmallRMS')
page()

heading('Workflow 04 / onboarding and routine', 'Set up once. Operate every day.')
section('First-run setup')
flow([
('Prepare deployment','Use HTTPS, persistent storage, production mode and unique secrets.'),
('Create the owner','At /platform, use the one-time setup token to create the platform owner.'),
('Create a store','Provision a blank restaurant; hand over its code and unique manager PIN.'),
('Configure operations','Set taxes, timezone, menu, tables, recipes and opening inventory.'),
('Configure people','Add staff, review role permissions and plan seat/module limits.'),
('Test & hand over','Verify service and reconciliation, test backups, then remove the setup token.')
])
section('Daily operating checklist')
table([
('<b>Before service</b>', 'Confirm the business day/drawer, staff attendance, menu availability, tables, stock and kitchen screens.'),
('<b>During service</b>', 'Watch open tickets, kitchen delays and guest requests. Approve QR orders and verify payments before checkout.'),
('<b>End of service</b>', 'Resolve open tickets; reconcile externally verified payments and drawer counts; review waste, stock and attendance.'),
('<b>Day close</b>', 'Use Z-report/business-day controls with the appropriate permissions. Review discrepancies and confirm backups.')
])
notice('<b>No sample records in production:</b> normal startup creates no demo restaurant, menu or sales history. Empty reports remain empty until real activity exists. Production refuses known demo seed markers; do not reuse a demo volume.')
page()

heading('Boundaries / handover', 'What is live, what still needs integration')
add('Configuration fields are not the same as working external integrations. Agree the client scope before promising automated settlement, delivery or hardware behaviour.')
table([
('<b>Core operational screens</b>', 'Implemented and locally verified. Client browser testing and role-based acceptance testing are still required.'),
('<b>Guest online payment</b>', 'Blocked outside demo mode. Requires real payment initiation, signed callbacks, amount/currency validation and duplicate-event protection.'),
('<b>Offline card capture</b>', 'New offline card authorizations and forwarding are blocked outside demo mode until provider capture/reconciliation exists.'),
('<b>Email receipts</b>', 'Records remain queued. A real sender/worker, retry policy and delivery tracking are required.'),
('<b>Vendor dispatch</b>', 'Automatic email/SFTP and retries are blocked. Real delivery transport or audited manual dispatch must be implemented.'),
('<b>Hardware & providers</b>', 'Device TCP checks are not printing or payment certification. Printers, terminals, SMS and delivery marketplaces need separate integration/UAT.')
])
section('Security and operating model')
bullet('A separate SQLite database holds each restaurant’s business records; a control database holds the platform registry. Use one application instance with durable storage and tested backups.')
bullet('Staff permissions are re-read on requests. Sessions expire server-side: 12 hours for staff and 8 hours for platform users. Mutating authenticated requests use CSRF protection.')
bullet('Outside demo mode, hardware checks require approved literal IPs; network discovery is disabled. Never expose setup secrets, staff PINs or backup files.')
section('Quick glossary')
add('<b>POS:</b> point of sale. <b>KDS:</b> kitchen display system. <b>Expo:</b> the pass/coordinator. <b>P-Mix:</b> product sales mix. <b>Z-report:</b> business-day close/reconciliation report. <b>86:</b> make an item unavailable. <b>Tenant:</b> an isolated restaurant workspace.', 'SmallRMS')
add('<b>Verification record:</b> 94 automated tests passed; TypeScript and production build passed; dependency audit reported no vulnerabilities at review time. These checks do not replace browser testing, penetration testing, provider certification or client sign-off. See docs/PRODUCTION_READINESS.md for details.', 'SmallRMS')

def footer(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(colors.HexColor('#D8E4E7')); canvas.line(50,47,545,47)
    canvas.setFont('Helvetica',8); canvas.setFillColor(GRAY)
    canvas.drawString(50,32,'RMS  |  System & workflow guide  |  19 November 2026')
    canvas.drawRightString(545,32,f'{doc.page}')
    canvas.restoreState()

doc = SimpleDocTemplate(str(OUTPUT),pagesize=(595.28,841.89),rightMargin=50,leftMargin=50,topMargin=45,bottomMargin=62,title='RMS - System and Workflow Guide',author='RMS Project',subject='Features, roles, workflow diagrams and production boundaries')
doc.build(story,onFirstPage=footer,onLaterPages=footer)
print(OUTPUT)
