# Minitest 6 no longer includes minitest/mock. Keep transport stubs local to tests.
module BillieMethodStub
  def stub_method(object, name, replacement)
    singleton = object.singleton_class
    originally_local = singleton.instance_methods(false).include?(name)
    original = singleton.instance_method(name) if originally_local
    singleton.define_method(name) do |*args, **kwargs, &block|
      replacement.respond_to?(:call) ? replacement.call(*args, **kwargs, &block) : replacement
    end
    yield
  ensure
    singleton.remove_method(name)
    singleton.define_method(name, original) if originally_local
  end
end
