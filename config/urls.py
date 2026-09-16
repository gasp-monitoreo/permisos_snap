from django.urls import path
from tramites.api import api
from tramites import views

urlpatterns = [
    path('', views.index, name='index'),
    path('api/', api.urls),
    path('investigaciones/', views.serve_investigacion, name='inv-root'),
    path('investigaciones/<path:filepath>', views.serve_investigacion, name='inv-file'),
    path('auth/gmail/start', views.gmail_auth_start, name='gmail-start'),
    path('auth/gmail/callback', views.gmail_auth_callback, name='gmail-callback'),
]
