// Fast CSV reader: run(input) returns exactly csv-reader 1.0.0's answer
// ({columns, rows, errors}) for {text, header}, but much faster.
//
// Written from scratch from the competition spec (RULES.txt). The reading
// policy, re-stated in my own words:
//
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF; a line left with no characters is no record;
//   - outside quotes a CR not followed by LF is dropped (error stray_cr);
//   - a field opening with a quote runs to the next quote that is not
//     doubled ("" inside is one quote), each CRLF or lone CR inside it is
//     read as LF; what follows its closing quote, up to the next comma or
//     line break, is appended as it stands (quote_junk when the field ends);
//     a quote that never closes is a literal character and the text after it
//     is read again as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character;
//   - fields stay strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds
//     the records after it (every record when header is false), each padded
//     with "" (short_row, with fields: its field count) or cut (long_row,
//     with extra: the cut fields) to the first record's width;
//   - each error is {code, line, row}, in the order met; line is the 1-based
//     line its record starts on (every LF, CRLF and lone CR inside a quoted
//     field counted), row its record's index in rows (null for the header);
//     a record's short_row/long_row is reported when the record ends.
//
// Speed comes from never scanning one character at a time on the common
// paths: unquoted fields jump to the next delimiter with indexOf, quoted
// fields jump straight to their closing quote, and whole quote-free lines
// are split at once. The slow, careful path only runs for quoted fields
// that contain a doubled quote or a line break. Field readers return the
// value directly and report how the field ended through shared slots, so
// no object is allocated per field.
//
// Field-end codes: 0 = comma, 1 = line break, 2 = end of text.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

const C_COMMA = 44; // ,
const C_QUOTE = 34; // "
const C_LF = 10; // \n
const C_CR = 13; // \r
const C_BOM = 0xFEFF;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = text.charCodeAt(0) === C_BOM ? 1 : 0;
  let line = 1; // the line the character at pos is on

  // The record being read: the line it starts on and the index in rows it
  // takes (null: the header). Every error of a record carries these two.
  let recordLine = 1;
  let recordRow = null;

  // Shared slots: how the last field ended, and how many characters the
  // last unquoted read kept.
  let ended = END;
  let added = 0;

  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads unquoted characters from pos up to the next comma or line break:
  // a CR not followed by LF is dropped (stray_cr). `value` is what the
  // field already holds (a quoted field's value when reading its junk, or
  // the literal opening quote after an unterminated quote). Returns the
  // field's value and sets `ended` and `added`.
  function readUnquoted(value) {
    if (pos >= n) {
      ended = END;
      added = 0;
      return value;
    }
    const cIdx = text.indexOf(',', pos);
    const nIdx = text.indexOf('\n', pos);
    let end;
    if (cIdx !== -1 && (nIdx === -1 || cIdx < nIdx)) {
      end = cIdx;
      ended = COMMA;
    } else if (nIdx !== -1) {
      end = nIdx;
      ended = LINE_BREAK;
    } else {
      end = n;
      ended = END;
    }
    let v = text.slice(pos, end);
    if (ended === LINE_BREAK) {
      // A CR right before the LF is the CRLF terminator, not a stray CR.
      if (v.charCodeAt(v.length - 1) === C_CR) v = v.slice(0, -1);
      pos = end + 1;
      line += 1;
    } else if (ended === COMMA) {
      pos = end + 1;
    } else {
      pos = n;
    }
    // Every CR left in the slice is stray: no LF follows it before the
    // next delimiter (a CR followed by LF would have ended the field at
    // that LF instead). Drop each one and report it.
    if (v.indexOf('\r') !== -1) {
      const parts = v.split('\r');
      for (let i = 1; i < parts.length; i++) error('stray_cr');
      v = parts.join('');
    }
    added = v.length;
    return value === '' ? v : value + v;
  }

  // What follows a quoted field's closing quote at q.
  function afterClose(value, q) {
    const nx = q + 1;
    if (nx >= n) {
      pos = n;
      ended = END;
      return value;
    }
    const c = text.charCodeAt(nx);
    if (c === C_COMMA) {
      pos = nx + 1;
      ended = COMMA;
      return value;
    }
    if (c === C_LF) {
      pos = nx + 1;
      line += 1;
      ended = LINE_BREAK;
      return value;
    }
    if (c === C_CR && text.charCodeAt(nx + 1) === C_LF) {
      pos = nx + 2;
      line += 1;
      ended = LINE_BREAK;
      return value;
    }
    // What follows the closing quote is appended as it stands, up to the
    // next comma or line break.
    pos = nx;
    const junk = readUnquoted(value);
    if (added > 0) error('quote_junk');
    return junk;
  }

  // Reads a quoted field whose opening quote is at pos, when the field
  // holds a doubled quote or a line break: segment by segment between
  // quotes, turning each CRLF or lone CR inside into one LF.
  function readQuotedCareful(open, openLine) {
    const parts = [];
    let p = open + 1;
    while (true) {
      const q = text.indexOf('"', p);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as an unquoted field.
        pos = open + 1;
        line = openLine;
        error('unterminated_quote');
        return readUnquoted('"');
      }
      let seg = text.slice(p, q);
      if (seg.indexOf('\r') !== -1 || seg.indexOf('\n') !== -1) {
        let out = '';
        for (let i = 0; i < seg.length; i++) {
          const ch = seg.charCodeAt(i);
          if (ch === C_CR) {
            out += '\n';
            line += 1;
            if (seg.charCodeAt(i + 1) === C_LF) i += 1;
          } else if (ch === C_LF) {
            out += '\n';
            line += 1;
          } else {
            out += seg[i];
          }
        }
        seg = out;
      }
      if (text.charCodeAt(q + 1) === C_QUOTE) {
        parts.push(seg, '"');
        p = q + 2;
        continue;
      }
      parts.push(seg);
      return afterClose(parts.length === 1 ? parts[0] : parts.join(''), q);
    }
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    const q = text.indexOf('"', pos + 1);
    if (q === -1) {
      // The quote never closes: it is a literal character, and the text
      // after it is read again as an unquoted field.
      pos = open + 1;
      line = openLine;
      error('unterminated_quote');
      return readUnquoted('"');
    }
    // Fast path: no doubled quote at the first candidate close, and no
    // line break inside the field. The value is one slice.
    const nl = text.indexOf('\n', pos + 1);
    const cr = text.indexOf('\r', pos + 1);
    if (
      (nl !== -1 && nl < q) ||
      (cr !== -1 && cr < q) ||
      text.charCodeAt(q + 1) === C_QUOTE
    ) {
      return readQuotedCareful(open, openLine);
    }
    return afterClose(text.slice(pos + 1, q), q);
  }

  // Finishes a record: header, or a row padded/cut to the first record's
  // width, with its short_row/long_row error when it ends.
  function processRecord(fields) {
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.slice(width) });
      fields.length = width;
    }
    rows.push(fields);
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === C_LF) {
        pos += 1;
        line += 1;
      } else if (c === C_CR && text.charCodeAt(pos + 1) === C_LF) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: this record's line holds no quote at all, so no field of
    // it can be quoted or span lines. Split the whole line at once.
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? n : nl;
    const qIdx = text.indexOf('"', pos);
    if (qIdx === -1 || qIdx >= lineEnd) {
      let seg = text.slice(pos, lineEnd);
      if (nl !== -1 && seg.charCodeAt(seg.length - 1) === C_CR) seg = seg.slice(0, -1);
      if (seg.indexOf('\r') !== -1) {
        const parts = seg.split('\r');
        for (let i = 1; i < parts.length; i++) error('stray_cr');
        seg = parts.join('');
      }
      const fields = seg.split(',');
      pos = nl === -1 ? n : nl + 1;
      if (nl !== -1) line += 1;
      // A line that held only stray CRs is left with no characters: no
      // record (its stray_cr errors stay).
      if (fields.length === 1 && fields[0] === '') continue;
      processRecord(fields);
      continue;
    }

    // Field by field: quoted fields jump to their closing quote, unquoted
    // fields jump to their next delimiter.
    const fields = [];
    let quoted = false;
    do {
      quoted = text.charCodeAt(pos) === C_QUOTE;
      fields.push(quoted ? readQuoted() : readUnquoted(''));
    } while (ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record.
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;
    processRecord(fields);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
