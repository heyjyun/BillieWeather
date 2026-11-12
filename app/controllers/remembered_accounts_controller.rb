# "Not you?" on the sign-in page: this browser forgets the remembered account.
# Only removes the hint cookie; it never signs anyone in or out.
class RememberedAccountsController < ApplicationController
  def destroy
    RememberedAccount.forget(cookies)
    redirect_to new_user_session_path, status: :see_other, notice: t("billie.quick_access.personal.forgotten")
  end
end
