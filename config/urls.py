from django.contrib.auth import views as auth_views
from django.urls import path
from tramites.api import api
from tramites import views
from tramites.usuarios import LoginForm

urlpatterns = [
    path('login/', auth_views.LoginView.as_view(template_name='login.html', authentication_form=LoginForm,
                                                redirect_authenticated_user=True), name='login'),
    path('salud', views.salud, name='salud'),
    path('manual/', views.manual, name='manual'),
    path('manual/pdf', views.manual_pdf, name='manual-pdf'),
    path('manual/img/<str:archivo>', views.manual_img_admin, name='manual-img-admin'),
    path('logout/', auth_views.LogoutView.as_view(), name='logout'),
    path('cambiar-clave/', views.cambiar_clave, name='cambiar-clave'),
    path('', views.index, name='index'),
    path('api/', api.urls),
    path('investigaciones/', views.serve_investigacion, name='inv-root'),
    path('investigaciones/<path:filepath>', views.serve_investigacion, name='inv-file'),
    path('fotos/<str:archivo>', views.serve_foto, name='foto'),
    path('login/fotos.json', views.login_fotos, name='login-fotos'),
    path('auth/gmail/start', views.gmail_auth_start, name='gmail-start'),
    path('auth/gmail/callback', views.gmail_auth_callback, name='gmail-callback'),
]
