'use strict';
/**
 * Gerador de BR Code PIX (EMV® QRCPS-MPM) para uso local/mock.
 * Serve para testar o fluxo completo sem chamar a BSPay: o payload gerado é
 * estruturalmente válido (TLV + CRC16-CCITT), apontando para uma chave de teste.
 */
const crypto = require('crypto');

const tlv = (id, value) => `${id}${String(value.length).padStart(2, '0')}${value}`;

/** CRC16/CCITT-FALSE — polinômio 0x1021, valor inicial 0xFFFF. Exigido pelo BR Code. */
function crc16(payload) {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * Monta o payload copia-e-cola.
 * @param {object} o
 * @param {string} o.key        chave PIX (CPF, e-mail, telefone ou aleatória) da conta recebedora
 * @param {number} o.amount     valor em BRL
 * @param {string} o.merchant   nome do recebedor (máx 25)
 * @param {string} o.city       cidade do recebedor (máx 15)
 * @param {string} [o.txid]     identificador (máx 25, sem caracteres especiais)
 * @param {string} [o.description]
 */
function buildPixPayload({ key, amount, merchant, city, txid, description }) {
  const gui = tlv('00', 'br.gov.bcb.pix');
  const keyField = tlv('01', String(key));
  const descField = description ? tlv('02', String(description).slice(0, 40)) : '';
  const mai = tlv('26', `${gui}${keyField}${descField}`);

  const safeTxid = txid
    ? String(txid).replace(/[^A-Za-z0-9]/g, '').slice(0, 25)
    : crypto.randomBytes(8).toString('hex').toUpperCase();

  let p = '';
  p += tlv('00', '01');                                     // Payload Format Indicator
  p += tlv('01', '12');                                     // Point of Initiation: 12 = uso único
  p += mai;                                                 // Merchant Account Information
  p += tlv('52', '0000');                                   // Merchant Category Code
  p += tlv('53', '986');                                    // Moeda: BRL
  if (amount && Number(amount) > 0) p += tlv('54', Number(amount).toFixed(2));
  p += tlv('58', 'BR');                                     // País
  p += tlv('59', String(merchant || 'RECEBEDOR').slice(0, 25).toUpperCase()); // Nome
  p += tlv('60', String(city || 'SAO PAULO').slice(0, 15).toUpperCase());     // Cidade
  p += tlv('62', tlv('05', safeTxid));                      // Additional Data Field (txid)
  p += '6304';                                              // CRC placeholder
  return p + crc16(p);
}

module.exports = { buildPixPayload, crc16 };
