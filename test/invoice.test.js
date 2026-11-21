const assert = require('node:assert/strict');
const test = require('node:test');
const invoice = require('../lib/invoice');
const pricing = require('../lib/pricing');
const reports = require('../lib/reports');

function billedOrder(items, coupon = '') {
  const { subtotal, discount, tax, total } = pricing.computeTotals(items, coupon);
  return { id: 1, items, coupon, subtotal, discount, tax, total };
}

test('printed invoice matches the billed GST and total for an HSN-priced order', () => {
  const order = billedOrder([{ name: 'Rice', hsn: '1006', price: 640, qty: 1 }]);
  const figures = invoice.computeInvoiceFigures(order);

  assert.deepEqual(
    [figures.total, figures.tax, figures.rows[0].gstPercent, figures.rows[0].lineTax],
    [672, 32, 5, 32]
  );
  const html = invoice.render(order);
  assert.match(html, /<td class="r">5%<\/td><td class="r">₹32\.00<\/td>/);
  assert.match(html, /Invoice Total<\/td><td class="r">₹672\.00/);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice/);
});

test('invoice and ledger agree for a full-price item at the default GST rate', () => {
  const order = billedOrder([{ name: 'Tea', hsn: '0902', price: 100, qty: 1 }]);
  const figures = invoice.computeInvoiceFigures(order);

  assert.equal(order.total, 118);
  assert.equal(figures.total, 118);
  assert.equal(figures.tax, 18);
  assert.equal(figures.cgst, 9);
  assert.equal(figures.sgst, 9);
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);
});

test('invoice uses capped percentage discount and post-discount GST across slabs', () => {
  const items = [
    { name: 'Rice', hsn: '1006', price: 800, qty: 2 },
    { name: 'Ghee', hsn: '0405', price: 400, qty: 1 }
  ];
  const order = billedOrder(items, 'SAVE10');
  const billed = pricing.computeTotals(items, order.coupon);
  const figures = invoice.computeInvoiceFigures(order);

  assert.deepEqual(billed.lines.map(line => [line.discount, line.gstPercent, line.tax]), [
    [120, 5, 74],
    [30, 12, 44.40]
  ]);
  assert.deepEqual([order.discount, order.tax, order.total], [150, 118.40, 1968.40]);
  assert.deepEqual(figures.rows.map(row => row.lineTax), [74, 44.40]);
  assert.deepEqual([figures.discount, figures.tax, figures.total], [150, 118.40, 1968.40]);
});

test('flat coupon reduces both billed and printed GST', () => {
  const order = billedOrder([{ name: 'Tea', hsn: '0902', price: 300, qty: 1 }], 'FLAT50');
  const figures = invoice.computeInvoiceFigures(order);

  assert.deepEqual([order.discount, order.tax, order.total], [50, 45, 295]);
  assert.deepEqual([figures.discount, figures.tax, figures.total], [50, 45, 295]);
});

test('invoice sums rounded line GST and splits the recorded tax', () => {
  const order = billedOrder([
    { name: 'Item A', price: 0.03, qty: 1 },
    { name: 'Item B', price: 0.03, qty: 1 }
  ]);
  const figures = invoice.computeInvoiceFigures(order);

  assert.deepEqual(figures.rows.map(row => row.lineTax), [0.01, 0.01]);
  assert.deepEqual([order.tax, order.total], [0.02, 0.08]);
  assert.deepEqual([figures.tax, figures.cgst, figures.sgst, figures.total], [0.02, 0.01, 0.01, 0.08]);
});

test('historical invoice retains billed GST when line GST cannot be reconstructed', () => {
  const order = {
    id: 1,
    items: [{ name: 'Tea', price: 100, qty: 1 }],
    subtotal: 100,
    discount: 0,
    tax: 17,
    total: 118
  };
  const report = reports.getGstReconciliation({
    orders: [order, { ...order, id: 2, status: 'cancelled' }]
  });

  assert.equal(report.totalChecked, 1);
  assert.equal(report.mismatchCount, 0);
  assert.equal(report.totalDelta, 0);
  assert.deepEqual(
    report.rows.map(row => [row.orderId, row.ledgerTax, row.invoiceTax, row.delta, row.matched]),
    [[1, 17, 17, 0, true]]
  );
  const figures = invoice.computeInvoiceFigures(order);
  assert.deepEqual([figures.tax, figures.cgst, figures.sgst, figures.total], [17, 8.5, 8.5, 118]);
  assert.equal(figures.rows[0].gstPercent, null);
  assert.equal(figures.rows[0].lineTax, null);
  assert.match(invoice.render(order), /Unavailable<\/td><td class="r">Unavailable/);
});
