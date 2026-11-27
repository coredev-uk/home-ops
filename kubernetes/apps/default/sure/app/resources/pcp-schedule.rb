# Keeps a PCP finance account in Sure on its agreement's schedule. Sure can't
# model a PCP: it charges no interest and has no optional final payment, so
# each monthly payment would come off the balance in full. After each payment
# lands on the finance account, this records the capital the agreement says is
# still owed, as a balance update on the payment's date. Idempotent: a payment
# that already has a balance update is left alone.
#
# The agreement's figures come from the environment (sure-secret):
#   PCP_ACCOUNT        name of the finance account in Sure
#   PCP_CREDIT         amount of credit
#   PCP_PAYMENT        monthly payment
#   PCP_PAYMENTS       number of monthly payments
#   PCP_FIRST_DUE      date of the first payment (YYYY-MM-DD); later ones fall
#                      on the same day of each following month
#   PCP_FINAL_PAYMENT  optional final payment, one month after the last
credit = BigDecimal(ENV.fetch("PCP_CREDIT"))
payment = BigDecimal(ENV.fetch("PCP_PAYMENT"))
payments = Integer(ENV.fetch("PCP_PAYMENTS"))
first_due = Date.iso8601(ENV.fetch("PCP_FIRST_DUE"))
final_payment = BigDecimal(ENV.fetch("PCP_FINAL_PAYMENT"))
# A direct debit can land a few days either side of its due date.
date_window = -3..5

# The agreement's own monthly rate: the one that makes the payments and the
# final payment worth exactly the credit.
present_value = lambda do |rate|
  (1..payments).sum { |t| payment.to_f / (1 + rate)**t } + final_payment.to_f / (1 + rate)**(payments + 1)
end
low, high = 0.0, 0.05
100.times do
  mid = (low + high) / 2
  present_value.(mid) > credit.to_f ? low = mid : high = mid
end
rate = (low + high) / 2

account = Account.find_by!(name: ENV.fetch("PCP_ACCOUNT"))
balance = credit.to_f
recorded = 0
payments.times do |n|
  due = first_due >> n
  balance = (balance * (1 + rate) - payment.to_f).round(2)
  break if due + date_window.first > Date.current

  paid = account.entries.where(entryable_type: "Transaction", amount: -payment)
                .where(date: (due + date_window.first)..(due + date_window.last)).order(:date).last
  next puts("Payment #{n + 1}: not on the finance account yet") unless paid
  next if account.entries.where(entryable_type: "Valuation", date: paid.date).exists?

  account.entries.create!(
    date: paid.date,
    name: "Balance per agreement (payment #{n + 1} of #{payments})",
    amount: balance,
    currency: account.currency,
    entryable: Valuation.new(kind: "reconciliation")
  )
  recorded += 1
  puts "Payment #{n + 1}: balance updated"
end

account.sync_later if recorded.positive?
puts "Recorded #{recorded} balance update(s)"
