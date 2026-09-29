const ITEMS_PER_PAGE = 9
const PAYMENT_EXPIRY_MINUTES = 5
const PAYMENT_CHECK_INTERVAL = 5
const MAX_PAYMENT_ATTEMPTS = 60
const providerPrefixes = {
  indosat: ['0814','0815','0816','0855','0856','0857','0858','0859'],
  smartfren: ['0881','0882','0883','0884','0885','0886','0887','0888'],
  telkomsel: ['0811','0812','0813','0821','0822','0852','0853'],
  axis: ['0831','0832','0833','0838'],
  xl: ['0817','0818','0819','0859','0877','0878']
}
const namaBulan = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember']

export { ITEMS_PER_PAGE, PAYMENT_EXPIRY_MINUTES, PAYMENT_CHECK_INTERVAL, MAX_PAYMENT_ATTEMPTS, providerPrefixes, namaBulan }
