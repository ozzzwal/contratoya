'use strict';
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const D = require('docx');
const T = require('./data/templates.json');

const BY = Object.fromEntries(T.map(t => [t.id, t]));
// Documentos de una sola parte, recibos, cartas y laborales: sin bloque de cláusulas generales ni pena convencional
const SK = new Set(['ren', 'fin', 'pag', 'car', 'mas', 'tex', 'rrent', 'rec', 'lab', 'prac']);
const LEAD = /^((?:[A-ZÁÉÍÓÚÑ,]+(?:\s[A-ZÁÉÍÓÚÑ,]+)*\.\s)+)/;

const GEN = [
  'DOMICILIOS Y NOTIFICACIONES. Las partes señalan como domicilio para notificaciones los indicados en este contrato; todo cambio deberá comunicarse por escrito a la otra parte.',
  'MODIFICACIONES. Este contrato solo podrá modificarse mediante escrito firmado por ambas partes.',
  'NULIDAD PARCIAL. Si alguna cláusula fuera declarada inválida, las demás conservarán su validez y obligatoriedad.',
  'ACUERDO ÍNTEGRO. Este contrato y sus anexos constituyen el acuerdo total entre las partes y sustituyen cualquier acuerdo anterior sobre el mismo objeto.',
  'FIRMA Y EJEMPLARES. Las partes suscriben este documento en los ejemplares que estimen necesarios. La firma electrónica podrá utilizarse cuando sea admisible conforme a la legislación aplicable y cumpla las formalidades correspondientes. La huella SHA-256 permite comprobar que un archivo coincide con el contenido registrado; por sí sola no identifica a las partes ni sustituye una firma o formalidad legal.',
  'DATOS PERSONALES. Los datos personales contenidos en este contrato se usarán únicamente para su celebración y cumplimiento, conforme a la ley aplicable.'
];

const fmtDate = s => new Date(s + 'T12:00:00').toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' });

// Valida y normaliza. strict=true exige todos los campos (documento final); false tolera faltantes (vista previa).
function clean(t, data, strict) {
  const o = {}, err = [];
  data = data && typeof data === 'object' ? data : {};
  for (const f of t.fields) {
    const ty = f[2] || 'text';
    let v = String(data[f[0]] ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!v) { if (strict) err.push(f[1]); continue; }
    if (ty === 'number') {
      const n = Number(v.replace(/,/g, ''));
      if (!isFinite(n) || n < 0 || n > 1e9) { if (strict) err.push(f[1]); continue; }
      v = n >= 1000 ? n.toLocaleString('en-US') : String(n);
    } else if (ty === 'date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || isNaN(new Date(v))) { if (strict) err.push(f[1]); continue; }
      v = fmtDate(v);
    }
    o[f[0]] = v;
  }
  return { o, err };
}

const fill = (s, d, L) => s.replace(/\{\{(\w+)\}\}/g, (_, k) => (d[k] !== undefined ? d[k] : `[ ${L[k] || k} ]`));

function build(t, d, meta) {
  const L = Object.fromEntries(t.fields.map(f => [f[0], f[1]]));
  const F = s => fill(s, d, L);
  const parts = F(t.b).split('\n\n');
  const title = parts.shift();
  let sig = null;
  for (let i = parts.length - 1; i >= 0; i--) if (/^Firmas?\b/.test(parts[i])) { sig = parts.splice(i, 1)[0]; break; }

  const out = [{ t: 'title', x: title }, { t: 'meta', x: `Folio ${meta.folio} · Generado el ${meta.date}` }];
  const full = !SK.has(t.id);
  const [f0, f1] = t.fields;
  const n1 = d[f0[0]] || `[ ${f0[1]} ]`, n2 = d[f1[0]] || `[ ${f1[1]} ]`;
  const role = f => f[1].replace(/^Nombre (del|de la|de) /i, '').replace(/^./, c => c.toUpperCase());
  const miss = k => d[k] || `[ ${L[k]} ]`;

  if (full) {
    out.push({ t: 'h', x: 'DATOS DE LAS PARTES' });
    [[f0, n1, 'dom1', 'id1'], [f1, n2, 'dom2', 'id2']].forEach(([f, n, dk, ik]) =>
      out.push({ t: 'p', x: `${role(f)}: ${n}, con domicilio en ${miss(dk)} e identificación oficial (INE o pasaporte) n.º ${miss(ik)}.` }));
    out.push({ t: 'h', x: 'DECLARACIONES' },
      { t: 'p', x: 'Cada una de las partes declara bajo protesta de decir verdad que: (a) es mayor de edad y tiene capacidad legal para obligarse; (b) los datos de identificación y domicilio proporcionados son verdaderos; y (c) celebra este contrato de forma libre, sin error, dolo, violencia ni lesión.' },
      { t: 'h', x: 'CLÁUSULAS' });
  }
  parts.forEach(x => out.push({ t: 'p', x }));

  if (full) {
    const viv = t.cat === 'Vivienda';
    if (t.id !== 'arr') out.push({ t: 'p', x: 'INCUMPLIMIENTO Y TERMINACIÓN. Si una parte considera que la otra ha incumplido, podrá notificarle por escrito los hechos y solicitar que se subsanen dentro de 5 días naturales, cuando la naturaleza del incumplimiento permita corregirlo y la ley aplicable no establezca otro plazo. La terminación, los intereses o cualquier pena convencional solo procederán cuando estén expresamente pactados y sean permitidos por la legislación aplicable. Las partes podrán ejercer los derechos y acciones que correspondan conforme a dicha legislación.' });
    if (viv && t.id !== 'arr') out.push({ t: 'p', x: 'ESTADO DEL INMUEBLE Y SERVICIOS. El inmueble se entrega en el estado que consta en el inventario y las fotografías anexos, firmados por ambas partes. El arrendador responde por los vicios ocultos. Los servicios (luz, agua, gas, internet) los paga quien los consume y el mantenimiento mayor corresponde al propietario.' });
    GEN.forEach(x => out.push({ t: 'p', x }));
    out.push({ t: 'p', x: 'ANEXOS. (1) Copia de identificación oficial vigente (INE o pasaporte) de ambas partes.' + (viv ? ' (2) Anexo de Inventario, firmado por ambas partes.' : '') });
    if (viv) out.push({ t: 'text', x: 'ANEXO DE INVENTARIO\nObjeto | Cantidad | Estado (nuevo / bueno / regular / dañado)\n1. ____________ | ______ | ____________\n2. ____________ | ______ | ____________\n3. ____________ | ______ | ____________\n4. ____________ | ______ | ____________' });
    if (t.id === 'arr') out.push({ t: 'p', x: F('RECIBO DE DEPÓSITO. Recibí de {{arrendatario}} la cantidad de {{deposito}} USD por concepto de depósito en garantía, en la fecha de firma de este contrato.') + '\nFirma de quien recibe: ____________' });
    if (t.id === 'pcv') out.push({ t: 'p', x: F('RECIBO DE ANTICIPO. Recibí de {{promitente_c}} la cantidad de {{arras}} USD por concepto de anticipo.') + '\nFirma de quien recibe: ____________' });
  }

  if (sig) out.push(/^Firmas:/.test(sig) ? { t: 'sig', a: n1, b: n2 } : { t: 'text', x: sig });
  if (meta.folio === 'BORRADOR') return { out, hash: null };
  const hash = crypto.createHash('sha256').update(JSON.stringify(out)).digest('hex');
  out.push({ t: 'foot', x: `Folio ${meta.folio} · Huella digital SHA-256: ${hash}\nDocumento generado mediante ContratoYa a partir de una plantilla informativa. No constituye asesoría legal; para operaciones de alto valor o casos complejos se recomienda la revisión de un abogado. Las partes son responsables de la veracidad de los datos capturados.` });
  return { out, hash };
}

function pdf(out, stream) {
  const doc = new PDFDocument({ size: 'LETTER', margins: { top: 72, bottom: 72, left: 78, right: 78 }, bufferPages: true, info: { Title: out[0].x, Author: 'ContratoYa' } });
  doc.pipe(stream);
  const W = doc.page.width - 156;
  for (const b of out) {
    if (b.t === 'title') doc.font('Times-Bold').fontSize(15).fillColor('#000').text(b.x, { align: 'center' }).moveDown(0.3);
    else if (b.t === 'meta') doc.font('Times-Italic').fontSize(9).fillColor('#555').text(b.x, { align: 'center' }).moveDown(1);
    else if (b.t === 'h') {
      doc.moveDown(0.65).font('Helvetica-Bold').fontSize(9).fillColor('#146454').text(b.x, { align: 'left', characterSpacing: 0.6 }).moveDown(0.3);
      doc.moveTo(78, doc.y).lineTo(78 + W, doc.y).lineWidth(0.5).strokeColor('#dce6e1').stroke().moveDown(0.35);
    }
    else if (b.t === 'p' || b.t === 'text') {
      const m = LEAD.exec(b.x), al = b.x.includes('\n') ? 'left' : 'justify';
      doc.fontSize(11).fillColor('#000');
      if (m && b.t === 'p' && m[0].length < b.x.length) {
        doc.font('Times-Bold').text(m[0], { continued: true, align: al, lineGap: 2 }).font('Times-Roman').text(b.x.slice(m[0].length), { align: al, lineGap: 2 });
      } else doc.font('Times-Roman').text(b.x, { align: al, lineGap: 2 });
      doc.moveDown(0.6);
    } else if (b.t === 'sig') {
      if (doc.y > doc.page.height - 190) doc.addPage();
      const y = doc.y + 50;
      doc.moveTo(78, y).lineTo(78 + W / 2 - 20, y).stroke('#000').moveTo(78 + W / 2 + 20, y).lineTo(78 + W, y).stroke('#000');
      doc.font('Times-Bold').fontSize(10).fillColor('#000')
        .text(b.a, 78, y + 6, { width: W / 2 - 20, align: 'center' })
        .text(b.b, 78 + W / 2 + 20, y + 6, { width: W / 2 - 20, align: 'center' });
      doc.x = 78; doc.y = y + 60;
    } else if (b.t === 'foot') doc.moveDown(1).font('Times-Roman').fontSize(7.5).fillColor('#555').text(b.x, 78, doc.y, { width: W, align: 'left' });
  }
  const r = doc.bufferedPageRange(), folio = (out[1].x.split(' · ')[0]);
  for (let i = 0; i < r.count; i++) {
    doc.switchToPage(i); doc.page.margins.bottom = 0;
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#146454').text('CONTRATOYA', 78, 32, { lineBreak: false });
    doc.font('Helvetica').fontSize(8).fillColor('#66756d').text('DOCUMENTO PRIVADO', 78 + W - 110, 32, { width: 110, align: 'right', lineBreak: false });
    doc.moveTo(78, 49).lineTo(78 + W, 49).lineWidth(0.5).strokeColor('#dce6e1').stroke();
    doc.moveTo(78, doc.page.height - 60).lineTo(78 + W, doc.page.height - 60).lineWidth(0.5).strokeColor('#dce6e1').stroke();
    doc.font('Helvetica').fontSize(8).fillColor('#66756d').text(`${folio} · Página ${i + 1} de ${r.count}`, 78, doc.page.height - 48, { width: W, align: 'center', lineBreak: false });
  }
  doc.end();
}

async function docx(out) {
  const { Paragraph, TextRun, AlignmentType, Table, TableRow, TableCell, WidthType, BorderStyle, Header, Footer, PageNumber } = D;
  const runs = (x, bold) => x.split('\n').map((l, i) => new TextRun({ text: l, bold, break: i ? 1 : 0 }));
  const nb = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }, NB = { top: nb, bottom: nb, left: nb, right: nb };
  const cell = a => new TableCell({ borders: NB, width: { size: 50, type: WidthType.PERCENTAGE }, margins: { top: 160, bottom: 80, left: 160, right: 160 }, children: [
    new Paragraph({ spacing: { before: 800, after: 120 }, border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: '66756D', space: 2 } }, alignment: AlignmentType.CENTER, children: [new TextRun(' ')] }),
    new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: a, bold: true })] })] });
  const ch = [];
  for (const b of out) {
    if (b.t === 'title') ch.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 120 }, children: [new TextRun({ text: b.x, bold: true, size: 30 })] }));
    else if (b.t === 'meta') ch.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 240 }, children: [new TextRun({ text: b.x, italics: true, size: 18, color: '555555' })] }));
    else if (b.t === 'h') ch.push(new Paragraph({ spacing: { before: 300, after: 120 }, border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: 'DCE6E1', space: 5 } }, children: [new TextRun({ text: b.x, bold: true, font: 'Arial', size: 20, color: '146454' })] }));
    else if (b.t === 'p' || b.t === 'text') {
      const m = LEAD.exec(b.x);
      const kids = (m && b.t === 'p' && m[0].length < b.x.length) ? [new TextRun({ text: m[0], bold: true }), ...runs(b.x.slice(m[0].length))] : runs(b.x);
      ch.push(new Paragraph({ alignment: b.x.includes('\n') ? AlignmentType.LEFT : AlignmentType.JUSTIFIED, spacing: { after: 140 }, children: kids }));
    } else if (b.t === 'sig') ch.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, borders: { ...NB, insideHorizontal: nb, insideVertical: nb }, rows: [new TableRow({ children: [cell(b.a), cell(b.b)] })] }));
    else if (b.t === 'foot') ch.push(new Paragraph({ spacing: { before: 400 }, children: runs(b.x).map(r => r) }));
  }
  const doc = new Document0(out, ch);
  return D.Packer.toBuffer(doc);
}
function Document0(out, children) {
  return new D.Document({ creator: 'ContratoYa', title: out[0].x,
    styles: { default: { document: { run: { font: 'Times New Roman', size: 23 } } } },
    sections: [{
      properties: { page: { margin: { top: 1440, bottom: 1440, left: 1560, right: 1560 } } },
      headers: { default: new D.Header({ children: [new D.Paragraph({ border: { bottom: { style: D.BorderStyle.SINGLE, size: 4, color: 'DCE6E1', space: 5 } }, children: [new D.TextRun({ text: 'CONTRATOYA  |  DOCUMENTO PRIVADO', font: 'Arial', bold: true, size: 16, color: '146454' })] })] }) },
      footers: { default: new D.Footer({ children: [new D.Paragraph({ alignment: D.AlignmentType.CENTER, border: { top: { style: D.BorderStyle.SINGLE, size: 4, color: 'DCE6E1', space: 5 } }, children: [new D.TextRun({ text: `${out[1].x}  ·  Página `, font: 'Arial', size: 16, color: '66756D' }), new D.TextRun({ children: [D.PageNumber.CURRENT], font: 'Arial', size: 16, color: '66756D' })] })] }) },
      children
    }] });
}

module.exports = { T, BY, clean, build, pdf, docx, fmtDate };
